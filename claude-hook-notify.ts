#!/usr/bin/env node

/**
 * Claude Hook Notification Script
 * Called by Claude Code hooks to send Telegram notifications
 */

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { PROJECT_ROOT } from './src/utils/paths';
import Logger from './src/core/logger';

const logger = new Logger('hook:notify');

// Load environment variables from the project directory
const envPath = path.join(PROJECT_ROOT, '.env');

logger.debug('Hook script started from:', process.cwd());
logger.debug('Script location:', __filename);
logger.debug('Looking for .env at:', envPath);

if (fs.existsSync(envPath)) {
    logger.debug('.env file found, loading...');
    dotenv.config({ path: envPath });
} else {
    logger.error('.env file not found at:', envPath);
    logger.error('Available files in script directory:');
    try {
        const files = fs.readdirSync(PROJECT_ROOT);
        logger.error(files.join(', '));
    } catch (error: unknown) {
        logger.error('Cannot read directory:', (error as Error).message);
    }
    process.exit(1);
}

const TelegramChannel = require('./src/channels/telegram/telegram');
const DesktopChannel = require('./src/channels/local/desktop');
const EmailChannel = require('./src/channels/email/smtp');

interface ChannelEntry {
    name: string;
    channel: { send(notification: Record<string, unknown>): Promise<boolean> };
}

interface ChannelResult {
    name: string;
    success: boolean;
    error?: string;
}

async function sendHookNotification(): Promise<void> {
    try {
        logger.info('Sending notifications...');

        // Get notification type from command line argument
        const notificationType = process.argv[2] || 'completed';

        const channels: ChannelEntry[] = [];
        const results: ChannelResult[] = [];

        // Configure Desktop channel (always enabled for sound)
        const desktopChannel = new DesktopChannel({
            completedSound: 'Glass',
            waitingSound: 'Tink'
        });
        channels.push({ name: 'Desktop', channel: desktopChannel });

        // Configure Telegram channel if enabled
        if (process.env.TELEGRAM_ENABLED === 'true' && process.env.TELEGRAM_BOT_TOKEN) {
            const telegramConfig = {
                botToken: process.env.TELEGRAM_BOT_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID,
                groupId: process.env.TELEGRAM_GROUP_ID
            };

            if (telegramConfig.botToken && (telegramConfig.chatId || telegramConfig.groupId)) {
                const telegramChannel = new TelegramChannel(telegramConfig);
                channels.push({ name: 'Telegram', channel: telegramChannel });
            }
        }

        // Configure Email channel if enabled
        if (process.env.EMAIL_ENABLED === 'true' && process.env.SMTP_USER) {
            const emailConfig = {
                smtp: {
                    host: process.env.SMTP_HOST,
                    port: parseInt(process.env.SMTP_PORT || ''),
                    secure: process.env.SMTP_SECURE === 'true',
                    auth: {
                        user: process.env.SMTP_USER,
                        pass: process.env.SMTP_PASS
                    }
                },
                from: process.env.EMAIL_FROM,
                fromName: process.env.EMAIL_FROM_NAME,
                to: process.env.EMAIL_TO
            };

            if (emailConfig.smtp.host && emailConfig.smtp.auth.user && emailConfig.to) {
                const emailChannel = new EmailChannel(emailConfig);
                channels.push({ name: 'Email', channel: emailChannel });
            }
        }

        // Get current working directory and tmux session
        const currentDir = process.cwd();
        const projectName = path.basename(currentDir);

        // Try to get current tmux session
        let tmuxSession = process.env.TMUX_SESSION || 'claude-real';
        try {
            const { execSync } = require('child_process');
            const sessionOutput = execSync('tmux display-message -p "#S"', {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            if (sessionOutput) {
                tmuxSession = sessionOutput;
            }
        } catch {
            // Not in tmux or tmux not available, use default
        }

        // Create notification
        const notification = {
            type: notificationType,
            title: `Claude ${notificationType === 'completed' ? 'Task Completed' : 'Waiting for Input'}`,
            message: `Claude has ${notificationType === 'completed' ? 'completed a task' : 'is waiting for input'}`,
            project: projectName
        };

        logger.info(`Sending ${notificationType} notification for project: ${projectName}`);
        logger.debug(`Tmux session: ${tmuxSession}`);

        // Send notifications to all configured channels
        for (const { name, channel } of channels) {
            try {
                logger.debug(`Sending to ${name}...`);
                const result = await channel.send(notification);
                results.push({ name, success: result });

                if (result) {
                    logger.info(`${name} notification sent successfully`);
                } else {
                    logger.warn(`Failed to send ${name} notification`);
                }
            } catch (error: unknown) {
                logger.error(`${name} notification error:`, (error as Error).message);
                results.push({ name, success: false, error: (error as Error).message });
            }
        }

        // Report overall results
        const successful = results.filter(r => r.success).length;
        const total = results.length;

        if (successful > 0) {
            logger.info(`Successfully sent notifications via ${successful}/${total} channels`);
        } else {
            logger.error('All notification channels failed');
            process.exit(1);
        }

    } catch (error: unknown) {
        logger.error('Hook notification error:', (error as Error).message);
        process.exit(1);
    }
}

// Show usage if no arguments
if (process.argv.length < 2) {
    logger.error('Usage: node claude-hook-notify.js [completed|waiting]');
    process.exit(1);
}

sendHookNotification();
