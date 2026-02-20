/**
 * Telegram Webhook Handler
 * Handles incoming Telegram messages and commands
 */

import { optionalRequire } from '../../utils/optional-require';
const express = optionalRequire('express', 'Telegram webhook server') as any;
import crypto from 'crypto';
import httpJSON from '../../utils/http-request';
import path from 'path';
import fs from 'fs';
import Logger from '../../core/logger';
import ControllerInjector from '../../utils/controller-injector';

interface WebhookConfig {
    botToken?: string;
    botUsername?: string;
    chatId?: string;
    groupId?: string;
    whitelist?: string[];
    forceIPv4?: boolean;
    [key: string]: unknown;
}

interface SessionData {
    id: string;
    token: string;
    tmuxSession?: string;
    expiresAt: number;
    [key: string]: unknown;
}

interface TelegramMessage {
    chat: { id: number };
    from: { id: number };
    text?: string;
}

interface TelegramCallbackQuery {
    id: string;
    message: { chat: { id: number } };
    data: string;
}

interface TelegramUpdate {
    message?: TelegramMessage;
    callback_query?: TelegramCallbackQuery;
}

interface NetworkOptions {
    family?: number;
}

class TelegramWebhookHandler {
    config: WebhookConfig;
    logger: Logger;
    sessionsDir: string;
    injector: ControllerInjector;
    app: any;
    apiBaseUrl: string;
    botUsername: string | null;

    constructor(config: WebhookConfig = {}) {
        if (!express) {
            throw new Error('express is required for the Telegram webhook server. Install with: npm install express');
        }
        this.config = config;
        this.logger = new Logger('TelegramWebhook');
        this.sessionsDir = path.join(__dirname, '../../data/sessions');
        this.injector = new ControllerInjector();
        this.app = express();
        this.apiBaseUrl = 'https://api.telegram.org';
        this.botUsername = null; // Cache for bot username

        this._setupMiddleware();
        this._setupRoutes();
    }

    _setupMiddleware(): void {
        // Parse JSON for all requests
        this.app.use(express.json());
    }

    _setupRoutes(): void {
        // Telegram webhook endpoint
        this.app.post('/webhook/telegram', this._handleWebhook.bind(this));

        // Health check endpoint
        this.app.get('/health', (req: any, res: any) => {
            res.json({ status: 'ok', service: 'telegram-webhook' });
        });
    }

    /**
     * Generate network options for HTTP requests
     */
    _getNetworkOptions(): NetworkOptions {
        const options: NetworkOptions = {};
        if (this.config.forceIPv4) {
            options.family = 4;
        }
        return options;
    }

    async _handleWebhook(req: any, res: any): Promise<void> {
        try {
            const update: TelegramUpdate = req.body;

            // Handle different update types
            if (update.message) {
                await this._handleMessage(update.message);
            } else if (update.callback_query) {
                await this._handleCallbackQuery(update.callback_query);
            }

            res.status(200).send('OK');
        } catch (error: unknown) {
            this.logger.error('Webhook handling error:', (error as Error).message);
            res.status(500).send('Internal Server Error');
        }
    }

    async _handleMessage(message: TelegramMessage): Promise<void> {
        const chatId = message.chat.id;
        const userId = message.from.id;
        const messageText = message.text?.trim();

        if (!messageText) return;

        // Check if user is authorized
        if (!this._isAuthorized(userId, chatId)) {
            this.logger.warn(`Unauthorized user/chat: ${userId}/${chatId}`);
            await this._sendMessage(chatId, 'You are not authorized to use this bot.');
            return;
        }

        // Handle /start command
        if (messageText === '/start') {
            await this._sendWelcomeMessage(chatId);
            return;
        }

        // Handle /help command
        if (messageText === '/help') {
            await this._sendHelpMessage(chatId);
            return;
        }

        // Parse command
        const commandMatch = messageText.match(/^\/cmd\s+([A-Z0-9]{8})\s+(.+)$/i);
        if (!commandMatch) {
            // Check if it's a direct command without /cmd prefix
            const directMatch = messageText.match(/^([A-Z0-9]{8})\s+(.+)$/);
            if (directMatch) {
                await this._processCommand(chatId, directMatch[1], directMatch[2]);
            } else {
                await this._sendMessage(chatId,
                    'Invalid format. Use:\n`/cmd <TOKEN> <command>`\n\nExample:\n`/cmd ABC12345 analyze this code`',
                    { parse_mode: 'Markdown' });
            }
            return;
        }

        const token = commandMatch[1].toUpperCase();
        const command = commandMatch[2];

        await this._processCommand(chatId, token, command);
    }

    async _processCommand(chatId: number, token: string, command: string): Promise<void> {
        // Find session by token
        const session = await this._findSessionByToken(token);
        if (!session) {
            await this._sendMessage(chatId,
                'Invalid or expired token. Please wait for a new task notification.',
                { parse_mode: 'Markdown' });
            return;
        }

        // Check if session is expired
        if (session.expiresAt < Math.floor(Date.now() / 1000)) {
            await this._sendMessage(chatId,
                'Token has expired. Please wait for a new task notification.',
                { parse_mode: 'Markdown' });
            await this._removeSession(session.id);
            return;
        }

        try {
            // Inject command into tmux session
            const tmuxSession = session.tmuxSession || 'default';
            await this.injector.injectCommand(command, tmuxSession);

            // Send confirmation
            await this._sendMessage(chatId,
                `*Command sent successfully*\n\n*Command:* ${command}\n*Session:* ${tmuxSession}\n\nClaude is now processing your request...`,
                { parse_mode: 'Markdown' });

            // Log command execution
            this.logger.info(`Command injected - User: ${chatId}, Token: ${token}, Command: ${command}`);

        } catch (error: unknown) {
            this.logger.error('Command injection failed:', (error as Error).message);
            await this._sendMessage(chatId,
                `*Command execution failed:* ${(error as Error).message}`,
                { parse_mode: 'Markdown' });
        }
    }

    async _handleCallbackQuery(callbackQuery: TelegramCallbackQuery): Promise<void> {
        const chatId = callbackQuery.message.chat.id;
        const data = callbackQuery.data;

        // Answer callback query to remove loading state
        await this._answerCallbackQuery(callbackQuery.id);

        if (data.startsWith('personal:')) {
            const token = data.split(':')[1];
            // Send personal chat command format
            await this._sendMessage(chatId,
                `*Personal Chat Command Format:*\n\n\`/cmd ${token} <your command>\`\n\n*Example:*\n\`/cmd ${token} please analyze this code\`\n\n*Copy and paste the format above, then add your command!*`,
                { parse_mode: 'Markdown' });
        } else if (data.startsWith('group:')) {
            const token = data.split(':')[1];
            // Send group chat command format with @bot_name
            const botUsername = await this._getBotUsername();
            await this._sendMessage(chatId,
                `*Group Chat Command Format:*\n\n\`@${botUsername} /cmd ${token} <your command>\`\n\n*Example:*\n\`@${botUsername} /cmd ${token} please analyze this code\`\n\n*Copy and paste the format above, then add your command!*`,
                { parse_mode: 'Markdown' });
        } else if (data.startsWith('session:')) {
            const token = data.split(':')[1];
            // For backward compatibility - send help message for old callback buttons
            await this._sendMessage(chatId,
                `*How to send a command:*\n\nType:\n\`/cmd ${token} <your command>\`\n\nExample:\n\`/cmd ${token} please analyze this code\`\n\n*Tip:* New notifications have a button that auto-fills the command for you!`,
                { parse_mode: 'Markdown' });
        }
    }

    async _sendWelcomeMessage(chatId: number): Promise<void> {
        const message = `*Welcome to Claude Code Remote Bot!*\n\n` +
            `I'll notify you when Claude completes tasks or needs input.\n\n` +
            `When you receive a notification with a token, you can send commands back using:\n` +
            `\`/cmd <TOKEN> <your command>\`\n\n` +
            `Type /help for more information.`;

        await this._sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async _sendHelpMessage(chatId: number): Promise<void> {
        const message = `*Claude Code Remote Bot Help*\n\n` +
            `*Commands:*\n` +
            `\`/start\` - Welcome message\n` +
            `\`/help\` - Show this help\n` +
            `\`/cmd <TOKEN> <command>\` - Send command to Claude\n\n` +
            `*Example:*\n` +
            `\`/cmd ABC12345 analyze the performance of this function\`\n\n` +
            `*Tips:*\n` +
            `Tokens are case-insensitive\n` +
            `Tokens expire after 24 hours\n` +
            `You can also just type \`TOKEN command\` without /cmd`;

        await this._sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    _isAuthorized(userId: number, chatId: number): boolean {
        // Check whitelist
        const whitelist = this.config.whitelist || [];

        if (whitelist.includes(String(chatId)) || whitelist.includes(String(userId))) {
            return true;
        }

        // If no whitelist configured, allow configured chat/user
        if (whitelist.length === 0) {
            const configuredChatId = this.config.chatId || this.config.groupId;
            if (configuredChatId && String(chatId) === String(configuredChatId)) {
                return true;
            }
        }

        return false;
    }

    async _getBotUsername(): Promise<string> {
        if (this.botUsername) {
            return this.botUsername;
        }

        try {
            const response = await httpJSON.get(
                `${this.apiBaseUrl}/bot${this.config.botToken}/getMe`,
                this._getNetworkOptions() as any
            );

            if ((response.data as any).ok && (response.data as any).result.username) {
                this.botUsername = (response.data as any).result.username;
                return this.botUsername!;
            }
        } catch (error: unknown) {
            this.logger.error('Failed to get bot username:', (error as Error).message);
        }

        // Fallback to configured username or default
        return this.config.botUsername || 'claude_remote_bot';
    }

    async _findSessionByToken(token: string): Promise<SessionData | null> {
        const files = fs.readdirSync(this.sessionsDir);

        for (const file of files) {
            if (!file.endsWith('.json')) continue;

            const sessionPath = path.join(this.sessionsDir, file);
            try {
                const session: SessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
                if (session.token === token) {
                    return session;
                }
            } catch (error: unknown) {
                this.logger.error(`Failed to read session file ${file}:`, (error as Error).message);
            }
        }

        return null;
    }

    async _removeSession(sessionId: string): Promise<void> {
        const sessionFile = path.join(this.sessionsDir, `${sessionId}.json`);
        if (fs.existsSync(sessionFile)) {
            fs.unlinkSync(sessionFile);
            this.logger.debug(`Session removed: ${sessionId}`);
        }
    }

    async _sendMessage(chatId: number, text: string, options: Record<string, unknown> = {}): Promise<void> {
        try {
            await httpJSON.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/sendMessage`,
                { chat_id: chatId, text, ...options },
                this._getNetworkOptions() as any
            );
        } catch (error: unknown) {
            this.logger.error('Failed to send message:', (error as Error).message);
        }
    }

    async _answerCallbackQuery(callbackQueryId: string, text: string = ''): Promise<void> {
        try {
            await httpJSON.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/answerCallbackQuery`,
                { callback_query_id: callbackQueryId, text },
                this._getNetworkOptions() as any
            );
        } catch (error: unknown) {
            this.logger.error('Failed to answer callback query:', (error as Error).message);
        }
    }

    async setWebhook(webhookUrl: string): Promise<unknown> {
        try {
            const response = await httpJSON.post(
                `${this.apiBaseUrl}/bot${this.config.botToken}/setWebhook`,
                { url: webhookUrl, allowed_updates: ['message', 'callback_query'] },
                this._getNetworkOptions() as any
            );

            this.logger.info('Webhook set successfully:', response.data);
            return response.data;
        } catch (error: unknown) {
            this.logger.error('Failed to set webhook:', (error as Error).message);
            throw error;
        }
    }

    start(port: number = 3000): void {
        this.app.listen(port, () => {
            this.logger.info(`Telegram webhook server started on port ${port}`);
        });
    }
}

export = TelegramWebhookHandler;
