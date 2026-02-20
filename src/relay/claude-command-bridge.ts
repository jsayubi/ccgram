/**
 * Claude Command Bridge
 * Bridge for communicating with Claude Code via file system
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import Logger from '../core/logger';

interface CommandData {
    id: string;
    sessionId: string;
    command: string;
    timestamp: string;
    status: string;
    source: string;
    processedAt?: string;
    response?: string;
}

interface BridgeStatus {
    pendingCommands: number;
    processedCommands: number;
    commandsDir?: string;
    responseDir?: string;
    recentCommands?: Array<{ id: string; command: string; timestamp: string }>;
    error?: string;
}

class ClaudeCommandBridge {
    logger: Logger;
    commandsDir: string;
    responseDir: string;

    constructor() {
        this.logger = new Logger('CommandBridge');
        this.commandsDir = path.join(__dirname, '../data/commands');
        this.responseDir = path.join(__dirname, '../data/responses');

        this._ensureDirectories();
    }

    _ensureDirectories(): void {
        [this.commandsDir, this.responseDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }

    /**
     * Send command to Claude Code
     */
    async sendCommand(command: string, sessionId: string): Promise<boolean> {
        try {
            const timestamp = Date.now();
            const commandId = `${sessionId}_${timestamp}`;

            // Create command file
            const commandFile = path.join(this.commandsDir, `${commandId}.json`);
            const commandData: CommandData = {
                id: commandId,
                sessionId,
                command,
                timestamp: new Date().toISOString(),
                status: 'pending',
                source: 'email'
            };

            fs.writeFileSync(commandFile, JSON.stringify(commandData, null, 2));

            // Create notification file (Claude Code can monitor this file for changes)
            const notificationFile = path.join(this.commandsDir, '.new_command');
            fs.writeFileSync(notificationFile, commandId);

            this.logger.info(`Command sent via file bridge: ${commandId}`);

            // Try to use system notification
            await this._sendSystemNotification(command, commandId);

            return true;

        } catch (error: unknown) {
            this.logger.error('Failed to send command via bridge:', (error as Error).message);
            return false;
        }
    }

    async _sendSystemNotification(command: string, commandId: string): Promise<void> {
        try {
            const title = 'TaskPing - New Email Command';
            const body = `Command: ${command.length > 50 ? command.substring(0, 50) + '...' : command}\n\nClick to view details or enter command in Claude Code`;

            if (process.platform === 'darwin') {
                // macOS notification
                const script = `
                    display notification "${body.replace(/"/g, '\\"')}" with title "${title}" sound name "default"
                `;
                spawn('osascript', ['-e', script]);
            } else if (process.platform === 'linux') {
                // Linux notification
                spawn('notify-send', [title, body]);
            }

            this.logger.debug('System notification sent');
        } catch (error: unknown) {
            this.logger.warn('Failed to send system notification:', (error as Error).message);
        }
    }

    /**
     * Get pending commands
     */
    getPendingCommands(): CommandData[] {
        try {
            const files = fs.readdirSync(this.commandsDir)
                .filter(file => file.endsWith('.json'))
                .sort();

            const commands: CommandData[] = [];
            for (const file of files) {
                try {
                    const commandData: CommandData = JSON.parse(
                        fs.readFileSync(path.join(this.commandsDir, file), 'utf8')
                    );
                    if (commandData.status === 'pending') {
                        commands.push(commandData);
                    }
                } catch (error: unknown) {
                    this.logger.warn(`Failed to parse command file ${file}:`, (error as Error).message);
                }
            }

            return commands;
        } catch (error: unknown) {
            this.logger.error('Failed to get pending commands:', (error as Error).message);
            return [];
        }
    }

    /**
     * Mark command as processed
     */
    markCommandProcessed(commandId: string, status: string = 'completed', response: string = ''): void {
        try {
            const commandFile = path.join(this.commandsDir, `${commandId}.json`);

            if (fs.existsSync(commandFile)) {
                const commandData: CommandData = JSON.parse(fs.readFileSync(commandFile, 'utf8'));
                commandData.status = status;
                commandData.processedAt = new Date().toISOString();
                commandData.response = response;

                // Save to response directory
                const responseFile = path.join(this.responseDir, `${commandId}.json`);
                fs.writeFileSync(responseFile, JSON.stringify(commandData, null, 2));

                // Delete original command file
                fs.unlinkSync(commandFile);

                this.logger.info(`Command ${commandId} marked as ${status}`);
            }
        } catch (error: unknown) {
            this.logger.error(`Failed to mark command ${commandId} as processed:`, (error as Error).message);
        }
    }

    /**
     * Clean up old command and response files
     */
    cleanup(maxAge: number = 24): void {
        const cutoff = Date.now() - (maxAge * 60 * 60 * 1000);
        let cleaned = 0;

        [this.commandsDir, this.responseDir].forEach(dir => {
            try {
                const files = fs.readdirSync(dir).filter(file => file.endsWith('.json'));

                for (const file of files) {
                    const filePath = path.join(dir, file);
                    const stats = fs.statSync(filePath);

                    if (stats.mtime.getTime() < cutoff) {
                        fs.unlinkSync(filePath);
                        cleaned++;
                    }
                }
            } catch (error: unknown) {
                this.logger.warn(`Failed to cleanup directory ${dir}:`, (error as Error).message);
            }
        });

        if (cleaned > 0) {
            this.logger.info(`Cleaned up ${cleaned} old command files`);
        }
    }

    /**
     * Get bridge status
     */
    getStatus(): BridgeStatus {
        try {
            const pendingCommands = this.getPendingCommands();
            const responseFiles = fs.readdirSync(this.responseDir).filter(f => f.endsWith('.json'));

            return {
                pendingCommands: pendingCommands.length,
                processedCommands: responseFiles.length,
                commandsDir: this.commandsDir,
                responseDir: this.responseDir,
                recentCommands: pendingCommands.slice(-5).map(cmd => ({
                    id: cmd.id,
                    command: cmd.command.substring(0, 50) + '...',
                    timestamp: cmd.timestamp
                }))
            };
        } catch (error: unknown) {
            this.logger.error('Failed to get bridge status:', (error as Error).message);
            return {
                pendingCommands: 0,
                processedCommands: 0,
                error: (error as Error).message
            };
        }
    }
}

export = ClaudeCommandBridge;
