#!/usr/bin/env node

/**
 * Telegram Webhook Server
 * Starts the Telegram webhook server for receiving messages
 */

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { PROJECT_ROOT } from './src/utils/paths';
import Logger from './src/core/logger';

const TelegramWebhookHandler = require('./src/channels/telegram/webhook');

// Load environment variables
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

const logger = new Logger('Telegram-Webhook-Server');

// Load configuration
const config = {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    groupId: process.env.TELEGRAM_GROUP_ID,
    whitelist: process.env.TELEGRAM_WHITELIST ? process.env.TELEGRAM_WHITELIST.split(',').map(id => id.trim()) : [],
    port: process.env.TELEGRAM_WEBHOOK_PORT || 3001,
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL
};

// Validate configuration
if (!config.botToken) {
    logger.error('TELEGRAM_BOT_TOKEN must be set in .env file');
    process.exit(1);
}

if (!config.chatId && !config.groupId) {
    logger.error('Either TELEGRAM_CHAT_ID or TELEGRAM_GROUP_ID must be set in .env file');
    process.exit(1);
}

// Create and start webhook handler
const webhookHandler = new TelegramWebhookHandler(config);

async function start(): Promise<void> {
    logger.info('Starting Telegram webhook server...');
    logger.info(`Configuration:`);
    logger.info(`- Port: ${config.port}`);
    logger.info(`- Chat ID: ${config.chatId || 'Not set'}`);
    logger.info(`- Group ID: ${config.groupId || 'Not set'}`);
    logger.info(`- Whitelist: ${config.whitelist.length > 0 ? config.whitelist.join(', ') : 'None (using configured IDs)'}`);

    // Set webhook if URL is provided
    if (config.webhookUrl) {
        try {
            const webhookEndpoint = `${config.webhookUrl}/webhook/telegram`;
            logger.info(`Setting webhook to: ${webhookEndpoint}`);
            await webhookHandler.setWebhook(webhookEndpoint);
        } catch (error: unknown) {
            logger.error('Failed to set webhook:', (error as Error).message);
            logger.info('You can manually set the webhook using:');
            logger.info(`curl -X POST https://api.telegram.org/bot${config.botToken}/setWebhook -d "url=${config.webhookUrl}/webhook/telegram"`);
        }
    } else {
        logger.warn('TELEGRAM_WEBHOOK_URL not set. Please set the webhook manually.');
        logger.info('To set webhook manually, use:');
        logger.info(`curl -X POST https://api.telegram.org/bot${config.botToken}/setWebhook -d "url=https://your-domain.com/webhook/telegram"`);
    }

    webhookHandler.start(config.port);
}

start();

// Handle graceful shutdown
process.on('SIGINT', () => {
    logger.info('Shutting down Telegram webhook server...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Shutting down Telegram webhook server...');
    process.exit(0);
});
