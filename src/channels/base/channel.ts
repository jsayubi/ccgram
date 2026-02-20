/**
 * Base Notification Channel
 * Abstract base class for all notification channels
 */

import Logger from '../../core/logger';
import type { Notification } from '../../types';

interface ChannelStatus {
    name: string;
    enabled: boolean;
    configured: boolean | { valid: boolean; error?: string };
    supportsRelay: boolean;
}

interface ChannelConfig {
    enabled?: boolean;
    [key: string]: unknown;
}

abstract class NotificationChannel {
    name: string;
    config: ChannelConfig;
    logger: Logger;
    enabled: boolean;

    constructor(name: string, config: ChannelConfig = {}) {
        this.name = name;
        this.config = config;
        this.logger = new Logger(`Channel:${name}`);
        this.enabled = config.enabled !== false;
    }

    /**
     * Send a notification
     */
    async send(notification: Notification): Promise<boolean> {
        if (!this.enabled) {
            this.logger.debug('Channel disabled, skipping notification');
            return false;
        }

        this.logger.debug('Sending notification:', notification.type);

        try {
            const result = await this._sendImpl(notification);
            if (result) {
                this.logger.info(`Notification sent successfully: ${notification.type}`);
            } else {
                this.logger.warn(`Failed to send notification: ${notification.type}`);
            }
            return result;
        } catch (error: unknown) {
            this.logger.error('Error sending notification:', (error as Error).message);
            return false;
        }
    }

    /**
     * Test the channel configuration
     */
    async test(): Promise<boolean> {
        this.logger.debug('Testing channel...');

        const testNotification: Notification = {
            type: 'completed',
            title: 'CCGram Test',
            message: `Test notification from ${this.name} channel`,
            project: 'test-project',
            metadata: { test: true, timestamp: new Date().toISOString(), language: 'en' }
        };

        return await this.send(testNotification);
    }

    /**
     * Check if the channel supports command relay
     */
    supportsRelay(): boolean {
        return false;
    }

    /**
     * Handle incoming command from this channel (if supported)
     */
    async handleCommand(command: string, context: Record<string, unknown> = {}): Promise<boolean> {
        if (!this.supportsRelay()) {
            this.logger.warn('Channel does not support command relay');
            return false;
        }

        this.logger.info('Received command:', command);
        // Implemented by subclasses
        return false;
    }

    /**
     * Implementation-specific send logic
     * Must be implemented by subclasses
     */
    abstract _sendImpl(notification: Notification): Promise<boolean>;

    /**
     * Validate channel configuration
     */
    validateConfig(): boolean | { valid: boolean; error?: string } {
        return true;
    }

    /**
     * Get channel status
     */
    getStatus(): ChannelStatus {
        return {
            name: this.name,
            enabled: this.enabled,
            configured: this.validateConfig(),
            supportsRelay: this.supportsRelay()
        };
    }
}

export = NotificationChannel;
