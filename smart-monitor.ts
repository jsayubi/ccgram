#!/usr/bin/env node

/**
 * Smart Monitor - Detects both historical and new responses
 * Solves the issue of the monitor missing already-completed responses
 */

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { execSync } from 'child_process';
import { PROJECT_ROOT } from './src/utils/paths';
import Logger from './src/core/logger';

const logger = new Logger('monitor');

// Load environment variables
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const TelegramChannel = require('./src/channels/telegram/telegram');

interface ExtractedResponse {
    userQuestion: string;
    claudeResponse: string;
    lineIndex: number;
    responseId: string;
    type: string;
    fullDialog?: string;
}

class SmartMonitor {
    sessionName: string;
    lastOutput: string;
    processedResponses: Set<string>;
    checkInterval: number;
    isRunning: boolean;
    startupTime: number;
    telegram: InstanceType<typeof TelegramChannel>;

    constructor() {
        this.sessionName = process.env.TMUX_SESSION || 'claude-real';
        this.lastOutput = '';
        this.processedResponses = new Set();
        this.checkInterval = 1000;
        this.isRunning = false;
        this.startupTime = Date.now();

        // Setup Telegram
        if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
            const telegramConfig = {
                botToken: process.env.TELEGRAM_BOT_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID
            };
            this.telegram = new TelegramChannel(telegramConfig);
            logger.info('Smart Monitor configured successfully');
        } else {
            logger.error('Telegram not configured');
            process.exit(1);
        }
    }

    start(): void {
        this.isRunning = true;
        logger.info(`Starting smart monitor for session: ${this.sessionName}`);

        // Check for any unprocessed responses on startup
        this.checkForUnprocessedResponses();

        // Initial capture
        this.lastOutput = this.captureOutput();

        // Start monitoring
        this.monitor();
    }

    async checkForUnprocessedResponses(): Promise<void> {
        logger.debug('Checking for unprocessed responses...');

        const currentOutput = this.captureOutput();
        const responses = this.extractAllResponses(currentOutput);

        // Check if there are recent responses (within 5 minutes) that might be unprocessed
        const recentResponses = responses.filter(() => {
            const responseAge = Date.now() - this.startupTime;
            return responseAge < 5 * 60 * 1000;
        });

        if (recentResponses.length > 0) {
            logger.info(`Found ${recentResponses.length} potentially unprocessed responses`);

            // Send notification for the most recent response
            const latestResponse = recentResponses[recentResponses.length - 1];
            await this.sendNotificationForResponse(latestResponse);
        } else {
            logger.debug('No unprocessed responses found');
        }
    }

    captureOutput(): string {
        try {
            return execSync(`tmux capture-pane -t ${this.sessionName} -p`, {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });
        } catch (error: unknown) {
            logger.error('Error capturing tmux:', (error as Error).message);
            return '';
        }
    }

    autoApproveDialog(): void {
        try {
            logger.debug('Auto-approving Claude tool usage dialog...');

            // Send "1" to select the first option (usually "Yes")
            execSync(`tmux send-keys -t ${this.sessionName} '1'`, { encoding: 'utf8' });
            setTimeout(() => {
                execSync(`tmux send-keys -t ${this.sessionName} Enter`, { encoding: 'utf8' });
            }, 100);

            logger.debug('Auto-approval sent successfully');
        } catch (error: unknown) {
            logger.error('Failed to auto-approve dialog:', (error as Error).message);
        }
    }

    extractAllResponses(content: string): ExtractedResponse[] {
        const lines = content.split('\n');
        const responses: ExtractedResponse[] = [];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // Look for standard Claude responses
            if (line.startsWith('\u23FA ') && line.length > 2) {
                const responseText = line.substring(2).trim();

                // Find the corresponding user question
                let userQuestion = 'Recent command';
                for (let j = i - 1; j >= 0; j--) {
                    const prevLine = lines[j].trim();
                    if (prevLine.startsWith('> ') && prevLine.length > 2) {
                        userQuestion = prevLine.substring(2).trim();
                        break;
                    }
                }

                responses.push({
                    userQuestion,
                    claudeResponse: responseText,
                    lineIndex: i,
                    responseId: `${userQuestion}-${responseText}`.substring(0, 50),
                    type: 'standard'
                });
            }

            // Look for interactive dialogs/tool confirmations
            if (line.includes('Do you want to proceed?') ||
                line.includes('\u276F 1. Yes') ||
                line.includes('Tool use') ||
                (line.includes('\u2502') && (line.includes('serena') || line.includes('MCP') || line.includes('initial_instructions')))) {

                let dialogContent = '';
                let userQuestion = 'Recent command';

                for (let j = i; j >= Math.max(0, i - 50); j--) {
                    const prevLine = lines[j];
                    if (prevLine.includes('\u256D') || prevLine.includes('Tool use')) {
                        for (let k = j; k <= Math.min(lines.length - 1, i + 20); k++) {
                            if (lines[k].includes('\u2570')) {
                                dialogContent += lines[k] + '\n';
                                break;
                            }
                            dialogContent += lines[k] + '\n';
                        }
                        break;
                    }
                    if (prevLine.startsWith('> ') && prevLine.length > 2) {
                        userQuestion = prevLine.substring(2).trim();
                    }
                }

                if (dialogContent.length > 50) {
                    this.autoApproveDialog();

                    responses.push({
                        userQuestion,
                        claudeResponse: 'Claude requested tool permission - automatically approved. Processing...',
                        lineIndex: i,
                        responseId: `dialog-${userQuestion}-${Date.now()}`.substring(0, 50),
                        type: 'interactive',
                        fullDialog: dialogContent.substring(0, 500)
                    });
                    break;
                }
            }
        }

        return responses;
    }

    async monitor(): Promise<void> {
        while (this.isRunning) {
            await this.sleep(this.checkInterval);

            const currentOutput = this.captureOutput();

            if (currentOutput !== this.lastOutput) {
                logger.debug('Output changed, checking for new responses...');

                const oldResponses = this.extractAllResponses(this.lastOutput);
                const newResponses = this.extractAllResponses(currentOutput);

                const oldResponseIds = new Set(oldResponses.map(r => r.responseId));

                const actuallyNewResponses = newResponses.filter(response =>
                    !oldResponseIds.has(response.responseId) &&
                    !this.processedResponses.has(response.responseId)
                );

                if (actuallyNewResponses.length > 0) {
                    logger.info(`Found ${actuallyNewResponses.length} new responses`);

                    for (const response of actuallyNewResponses) {
                        await this.sendNotificationForResponse(response);
                        this.processedResponses.add(response.responseId);
                    }
                } else {
                    logger.debug('No new responses detected');
                }

                this.lastOutput = currentOutput;
            }
        }
    }

    async sendNotificationForResponse(response: ExtractedResponse): Promise<void> {
        try {
            logger.info('Sending notification for response:', response.claudeResponse.substring(0, 50) + '...');

            const notification = {
                type: 'completed',
                title: 'Claude Response Ready',
                message: 'Claude has responded to your command',
                project: 'claude-code-line',
                metadata: {
                    userQuestion: response.userQuestion,
                    claudeResponse: response.claudeResponse,
                    tmuxSession: this.sessionName,
                    workingDirectory: process.cwd(),
                    timestamp: new Date().toISOString(),
                    autoDetected: true
                }
            };

            const result = await this.telegram.send(notification);

            if (result) {
                logger.info('Notification sent successfully');
            } else {
                logger.warn('Failed to send notification');
            }

        } catch (error: unknown) {
            logger.error('Notification error:', (error as Error).message);
        }
    }

    sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    stop(): void {
        this.isRunning = false;
        logger.info('Smart Monitor stopped');
    }

    getStatus(): Record<string, unknown> {
        return {
            isRunning: this.isRunning,
            sessionName: this.sessionName,
            processedCount: this.processedResponses.size,
            uptime: Math.floor((Date.now() - this.startupTime) / 1000) + 's'
        };
    }
}

// Handle graceful shutdown
const monitor = new SmartMonitor();

process.on('SIGINT', () => {
    logger.info('Shutting down...');
    monitor.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    monitor.stop();
    process.exit(0);
});

// Start monitoring
monitor.start();
