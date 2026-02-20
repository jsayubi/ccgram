/**
 * LINE Notification Channel
 * Sends notifications via LINE Messaging API with command support
 */

import NotificationChannel from '../base/channel';
import { getUUID } from '../../utils/optional-require';
import httpJSON from '../../utils/http-request';
const uuidv4 = getUUID();
import path from 'path';
import fs from 'fs';
import TmuxMonitor from '../../utils/tmux-monitor';
import { execSync } from 'child_process';
import type { Notification } from '../../types';

interface LINEConfig {
    enabled?: boolean;
    channelAccessToken?: string;
    userId?: string;
    groupId?: string;
    [key: string]: unknown;
}

interface SessionRecord {
    id: string;
    token: string;
    type: string;
    created: string;
    expires: string;
    createdAt: number;
    expiresAt: number;
    tmuxSession: string;
    project: string;
    notification: Notification;
}

interface LINEMessage {
    type: string;
    text: string;
}

class LINEChannel extends NotificationChannel {
    sessionsDir: string;
    tmuxMonitor: TmuxMonitor;
    lineApiUrl: string;

    constructor(config: LINEConfig = {} as LINEConfig) {
        super('line', config);
        this.sessionsDir = path.join(__dirname, '../../data/sessions');
        this.tmuxMonitor = new TmuxMonitor();
        this.lineApiUrl = 'https://api.line.me/v2/bot/message';

        this._ensureDirectories();
        this._validateConfig();
    }

    _ensureDirectories(): void {
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
    }

    _validateConfig(): boolean {
        const config = this.config as LINEConfig;
        if (!config.channelAccessToken) {
            this.logger.warn('LINE Channel Access Token not found');
            return false;
        }
        if (!config.userId && !config.groupId) {
            this.logger.warn('LINE User ID or Group ID must be configured');
            return false;
        }
        return true;
    }

    _generateToken(): string {
        // Generate short Token (uppercase letters + numbers, 8 digits)
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let token = '';
        for (let i = 0; i < 8; i++) {
            token += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return token;
    }

    _getCurrentTmuxSession(): string | null {
        try {
            // Try to get current tmux session
            const tmuxSession = execSync('tmux display-message -p "#S"', {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();

            return tmuxSession || null;
        } catch (error: unknown) {
            // Not in a tmux session or tmux not available
            return null;
        }
    }

    async _sendImpl(notification: Notification): Promise<boolean> {
        if (!this._validateConfig()) {
            throw new Error('LINE channel not properly configured');
        }

        const config = this.config as LINEConfig;

        // Generate session ID and Token
        const sessionId = uuidv4();
        const token = this._generateToken();

        // Get current tmux session and conversation content
        const tmuxSession = this._getCurrentTmuxSession();
        if (tmuxSession && !notification.metadata) {
            const conversation = this.tmuxMonitor.getRecentConversation(tmuxSession);
            notification.metadata = {
                userQuestion: conversation.userQuestion || notification.message,
                claudeResponse: conversation.claudeResponse || notification.message,
                tmuxSession: tmuxSession,
                timestamp: new Date().toISOString(),
                language: 'en'
            };
        }

        // Create session record
        await this._createSession(sessionId, notification, token);

        // Generate LINE message
        const messages = this._generateLINEMessage(notification, sessionId, token);

        // Determine recipient (user or group)
        const to = config.groupId || config.userId;

        const requestData = {
            to: to,
            messages: messages
        };

        try {
            await httpJSON.post(
                `${this.lineApiUrl}/push`,
                requestData,
                {
                    headers: {
                        'Authorization': `Bearer ${config.channelAccessToken}`
                    }
                }
            );

            this.logger.info(`LINE message sent successfully, Session: ${sessionId}`);
            return true;
        } catch (error: unknown) {
            this.logger.error('Failed to send LINE message:', (error as Error).message);
            // Clean up failed session
            await this._removeSession(sessionId);
            return false;
        }
    }

    _generateLINEMessage(notification: Notification, sessionId: string, token: string): LINEMessage[] {
        const type = notification.type;
        const emoji = type === 'completed' ? '✅' : '⏳';
        const status = type === 'completed' ? 'Completed' : 'Waiting for Input';

        let messageText = `${emoji} Claude Task ${status}\n`;
        messageText += `Project: ${notification.project}\n`;
        messageText += `Session Token: ${token}\n\n`;

        if (notification.metadata) {
            if (notification.metadata.userQuestion) {
                const userQuestion = notification.metadata.userQuestion as string;
                messageText += `📝 Your question:\n${userQuestion.substring(0, 200)}`;
                if (userQuestion.length > 200) {
                    messageText += '...';
                }
                messageText += '\n\n';
            }

            if (notification.metadata.claudeResponse) {
                const claudeResponse = notification.metadata.claudeResponse as string;
                messageText += `🤖 Claude response:\n${claudeResponse.substring(0, 300)}`;
                if (claudeResponse.length > 300) {
                    messageText += '...';
                }
                messageText += '\n\n';
            }
        }

        messageText += `💬 Reply to this message with:\n`;
        messageText += `Token ${token} <your command>\n`;
        messageText += `to send a new command to Claude`;

        return [{
            type: 'text',
            text: messageText
        }];
    }

    async _createSession(sessionId: string, notification: Notification, token: string): Promise<void> {
        const session: SessionRecord = {
            id: sessionId,
            token: token,
            type: 'line',
            created: new Date().toISOString(),
            expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // Expires after 24 hours
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000),
            tmuxSession: (notification.metadata?.tmuxSession as string) || 'default',
            project: notification.project,
            notification: notification
        };

        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        fs.writeFileSync(sessionFile, JSON.stringify(session, null, 2));

        this.logger.debug(`Session created: ${sessionId}`);
    }

    async _removeSession(sessionId: string): Promise<void> {
        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            this.logger.debug(`Session removed: ${sessionId}`);
        }
    }

    supportsRelay(): boolean {
        return true;
    }

    validateConfig(): boolean {
        return this._validateConfig();
    }
}

export = LINEChannel;
