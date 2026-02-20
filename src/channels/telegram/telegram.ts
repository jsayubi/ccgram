/**
 * Telegram Notification Channel
 * Sends notifications via Telegram Bot API with command support
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

interface TelegramConfig {
    enabled?: boolean;
    botToken?: string;
    chatId?: string;
    groupId?: string;
    forceIPv4?: boolean;
    botUsername?: string;
    [key: string]: unknown;
}

interface NetworkOptions {
    family?: 4;
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

interface TelegramRequestData {
    chat_id: string;
    text: string;
    parse_mode: string;
    reply_markup: {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
}

class TelegramChannel extends NotificationChannel {
    sessionsDir: string;
    tmuxMonitor: TmuxMonitor;
    apiBaseUrl: string;
    botUsername: string | null;

    constructor(config: TelegramConfig = {}) {
        super('telegram', config);
        this.sessionsDir = path.join(__dirname, '../../data/sessions');
        this.tmuxMonitor = new TmuxMonitor();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.botUsername = null; // Cache for bot username

        this._ensureDirectories();
        this._validateConfig();
    }

    _ensureDirectories(): void {
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
    }

    _validateConfig(): boolean {
        const config = this.config as TelegramConfig;
        if (!config.botToken) {
            this.logger.warn('Telegram Bot Token not found');
            return false;
        }
        if (!config.chatId && !config.groupId) {
            this.logger.warn('Telegram Chat ID or Group ID must be configured');
            return false;
        }
        return true;
    }

    /**
     * Generate network options for HTTP requests
     */
    _getNetworkOptions(): NetworkOptions {
        const options: NetworkOptions = {};
        if ((this.config as TelegramConfig).forceIPv4) {
            options.family = 4;
        }
        return options;
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

    async _getBotUsername(): Promise<string> {
        if (this.botUsername) {
            return this.botUsername;
        }

        const config = this.config as TelegramConfig;

        try {
            const response = await httpJSON.get(
                `${this.apiBaseUrl}/bot${config.botToken}/getMe`,
                this._getNetworkOptions()
            );

            const data = response.data as { ok: boolean; result: { username: string } };
            if (data.ok && data.result.username) {
                this.botUsername = data.result.username;
                return this.botUsername;
            }
        } catch (error: unknown) {
            this.logger.error('Failed to get bot username:', (error as Error).message);
        }

        // Fallback to configured username or default
        return config.botUsername || 'claude_remote_bot';
    }

    async _sendImpl(notification: Notification): Promise<boolean> {
        if (!this._validateConfig()) {
            throw new Error('Telegram channel not properly configured');
        }

        const config = this.config as TelegramConfig;

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

        // Generate Telegram message
        const messageText = this._generateTelegramMessage(notification, sessionId, token);

        // Determine recipient (chat or group)
        const chatId = config.groupId || config.chatId;
        const isGroupChat = !!config.groupId;

        // Create buttons using callback_data instead of inline query
        // This avoids the automatic @bot_name addition
        const buttons = [
            [
                {
                    text: '\u{1f4dd} Personal Chat',
                    callback_data: `personal:${token}`
                },
                {
                    text: '\u{1f465} Group Chat',
                    callback_data: `group:${token}`
                }
            ]
        ];

        const requestData: TelegramRequestData = {
            chat_id: chatId!,
            text: messageText,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: buttons
            }
        };

        try {
            await httpJSON.post(
                `${this.apiBaseUrl}/bot${config.botToken}/sendMessage`,
                requestData,
                this._getNetworkOptions()
            );

            this.logger.info(`Telegram message sent successfully, Session: ${sessionId}`);
            return true;
        } catch (error: unknown) {
            this.logger.error('Failed to send Telegram message:', (error as Error).message);
            // Clean up failed session
            await this._removeSession(sessionId);
            return false;
        }
    }

    _generateTelegramMessage(notification: Notification, sessionId: string, token: string): string {
        const type = notification.type;
        const emoji = type === 'completed' ? '\u2705' : '\u23f3';
        const status = type === 'completed' ? 'Completed' : 'Waiting for Input';

        let messageText = `${emoji} *Claude Task ${status}*\n`;
        messageText += `*Project:* ${notification.project}\n`;
        messageText += `*Session Token:* \`${token}\`\n\n`;

        if (notification.metadata) {
            if (notification.metadata.userQuestion) {
                const userQuestion = notification.metadata.userQuestion as string;
                messageText += `\u{1f4dd} *Your Question:*\n${userQuestion.substring(0, 200)}`;
                if (userQuestion.length > 200) {
                    messageText += '...';
                }
                messageText += '\n\n';
            }

            if (notification.metadata.claudeResponse) {
                const claudeResponse = notification.metadata.claudeResponse as string;
                messageText += `\u{1f916} *Claude Response:*\n${claudeResponse.substring(0, 300)}`;
                if (claudeResponse.length > 300) {
                    messageText += '...';
                }
                messageText += '\n\n';
            }
        }

        messageText += `\u{1f4ac} *To send a new command:*\n`;
        messageText += `Reply with: \`/cmd ${token} <your command>\`\n`;
        messageText += `Example: \`/cmd ${token} Please analyze this code\``;

        return messageText;
    }

    async _createSession(sessionId: string, notification: Notification, token: string): Promise<void> {
        const session: SessionRecord = {
            id: sessionId,
            token: token,
            type: 'telegram',
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

export = TelegramChannel;
