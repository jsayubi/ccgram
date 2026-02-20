/**
 * LINE Webhook Handler
 * Handles incoming LINE messages and commands
 */

import { optionalRequire } from '../../utils/optional-require';
const express = optionalRequire('express', 'LINE webhook server') as any;
import crypto from 'crypto';
import httpJSON from '../../utils/http-request';
import path from 'path';
import fs from 'fs';
import Logger from '../../core/logger';
import ControllerInjector from '../../utils/controller-injector';

interface LINEWebhookConfig {
    channelSecret?: string;
    channelAccessToken?: string;
    userId?: string;
    groupId?: string;
    whitelist?: string[];
    [key: string]: unknown;
}

interface LINEEvent {
    type: string;
    source: {
        userId?: string;
        groupId?: string;
        type: string;
    };
    message: {
        type: string;
        text: string;
    };
    replyToken: string;
}

interface SessionData {
    id: string;
    token: string;
    type: string;
    tmuxSession?: string;
    expiresAt: number;
    [key: string]: unknown;
}

class LINEWebhookHandler {
    config: LINEWebhookConfig;
    logger: Logger;
    sessionsDir: string;
    injector: ControllerInjector;
    app: any;

    constructor(config: LINEWebhookConfig = {}) {
        if (!express) {
            throw new Error('express is required for the LINE webhook server. Install with: npm install express');
        }
        this.config = config;
        this.logger = new Logger('LINEWebhook');
        this.sessionsDir = path.join(__dirname, '../../data/sessions');
        this.injector = new ControllerInjector();
        this.app = express();

        this._setupMiddleware();
        this._setupRoutes();
    }

    _setupMiddleware(): void {
        // Parse raw body for signature verification
        this.app.use('/webhook', express.raw({ type: 'application/json' }));

        // Parse JSON for other routes
        this.app.use(express.json());
    }

    _setupRoutes(): void {
        // LINE webhook endpoint
        this.app.post('/webhook', this._handleWebhook.bind(this));

        // Health check endpoint
        this.app.get('/health', (req: any, res: any) => {
            res.json({ status: 'ok', service: 'line-webhook' });
        });
    }

    _validateSignature(body: Buffer, signature: string): boolean {
        if (!this.config.channelSecret) {
            this.logger.error('Channel Secret not configured');
            return false;
        }

        const hash = crypto
            .createHmac('SHA256', this.config.channelSecret)
            .update(body)
            .digest('base64');

        return hash === signature;
    }

    async _handleWebhook(req: any, res: any): Promise<void> {
        const signature = req.headers['x-line-signature'];

        // Validate signature
        if (!this._validateSignature(req.body, signature)) {
            this.logger.warn('Invalid signature');
            res.status(401).send('Unauthorized');
            return;
        }

        try {
            const events: LINEEvent[] = JSON.parse(req.body.toString()).events;

            for (const event of events) {
                if (event.type === 'message' && event.message.type === 'text') {
                    await this._handleTextMessage(event);
                }
            }

            res.status(200).send('OK');
        } catch (error: unknown) {
            this.logger.error('Webhook handling error:', (error as Error).message);
            res.status(500).send('Internal Server Error');
        }
    }

    async _handleTextMessage(event: LINEEvent): Promise<void> {
        const userId = event.source.userId;
        const groupId = event.source.groupId;
        const messageText = event.message.text.trim();
        const replyToken = event.replyToken;

        // Check if user is authorized
        if (!this._isAuthorized(userId, groupId)) {
            this.logger.warn(`Unauthorized user/group: ${userId || groupId}`);
            await this._replyMessage(replyToken, '⚠️ You are not authorized to use this feature');
            return;
        }

        // Parse command
        const commandMatch = messageText.match(/^Token\s+([A-Z0-9]{8})\s+(.+)$/i);
        if (!commandMatch) {
            await this._replyMessage(replyToken,
                '❌ Invalid format. Usage:\nToken <8-char Token> <your command>\n\nExample:\nToken ABC12345 Please analyze this code');
            return;
        }

        const token = commandMatch[1].toUpperCase();
        const command = commandMatch[2];

        // Find session by token
        const session = await this._findSessionByToken(token);
        if (!session) {
            await this._replyMessage(replyToken,
                '❌ Invalid or expired token. Please wait for a new task notification.');
            return;
        }

        // Check if session is expired
        if (session.expiresAt < Math.floor(Date.now() / 1000)) {
            await this._replyMessage(replyToken,
                '❌ Token has expired. Please wait for a new task notification.');
            await this._removeSession(session.id);
            return;
        }

        try {
            // Inject command into tmux session
            const tmuxSession = session.tmuxSession || 'default';
            await this.injector.injectCommand(command, tmuxSession);

            // Send confirmation
            await this._replyMessage(replyToken,
                `✅ Command sent\n\n📝 Command: ${command}\n🖥️ Session: ${tmuxSession}\n\nPlease wait, Claude is processing your request...`);

            // Log command execution
            this.logger.info(`Command injected - User: ${userId}, Token: ${token}, Command: ${command}`);

        } catch (error: unknown) {
            this.logger.error('Command injection failed:', (error as Error).message);
            await this._replyMessage(replyToken,
                `❌ Command execution failed: ${(error as Error).message}`);
        }
    }

    _isAuthorized(userId: string | undefined, groupId: string | undefined): boolean {
        // Check whitelist
        const whitelist = this.config.whitelist || [];

        if (groupId && whitelist.includes(groupId)) {
            return true;
        }

        if (userId && whitelist.includes(userId)) {
            return true;
        }

        // If no whitelist configured, allow configured user/group
        if (whitelist.length === 0) {
            if (groupId && groupId === this.config.groupId) {
                return true;
            }
            if (userId && userId === this.config.userId) {
                return true;
            }
        }

        return false;
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

    async _replyMessage(replyToken: string, text: string): Promise<void> {
        try {
            await httpJSON.post(
                'https://api.line.me/v2/bot/message/reply',
                { replyToken, messages: [{ type: 'text', text }] },
                {
                    headers: {
                        'Authorization': `Bearer ${this.config.channelAccessToken}`
                    }
                }
            );
        } catch (error: unknown) {
            this.logger.error('Failed to reply message:', (error as Error).message);
        }
    }

    start(port: number = 3000): void {
        this.app.listen(port, () => {
            this.logger.info(`LINE webhook server started on port ${port}`);
        });
    }
}

export = LINEWebhookHandler;
