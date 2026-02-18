/**
 * Base Notification Channel
 * Abstract base class for all notification channels
 */

const Logger = require('../../core/logger');

class NotificationChannel {
    constructor(name, config = {}) {
        this.name = name;
        this.config = config;
        this.logger = new Logger(`Channel:${name}`);
        this.enabled = config.enabled !== false;
    }

    /**
     * Send a notification
     * @param {Object} notification - Notification object
     * @param {string} notification.type - Type: 'completed' | 'waiting'
     * @param {string} notification.title - Notification title
     * @param {string} notification.message - Notification message
     * @param {string} notification.project - Project name
     * @param {Object} notification.metadata - Additional metadata
     * @returns {Promise<boolean>} Success status
     */
    async send(notification) {
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
        } catch (error) {
            this.logger.error('Error sending notification:', error.message);
            return false;
        }
    }

    /**
     * Test the channel configuration
     * @returns {Promise<boolean>} Test success status
     */
    async test() {
        this.logger.debug('Testing channel...');
        
        const testNotification = {
            type: 'completed',
            title: 'CCGram Test',
            message: `Test notification from ${this.name} channel`,
            project: 'test-project',
            metadata: { test: true }
        };

        return await this.send(testNotification);
    }

    /**
     * Check if the channel supports command relay
     * @returns {boolean} Support status
     */
    supportsRelay() {
        return false;
    }

    /**
     * Handle incoming command from this channel (if supported)
     * @param {string} command - Command to execute
     * @param {Object} context - Command context
     * @returns {Promise<boolean>} Success status
     */
    async handleCommand(command, context = {}) {
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
     * @param {Object} notification - Notification object
     * @returns {Promise<boolean>} Success status
     */
    async _sendImpl(notification) {
        throw new Error('_sendImpl must be implemented by subclass');
    }

    /**
     * Validate channel configuration
     * @returns {boolean} Validation status
     */
    validateConfig() {
        return true;
    }

    /**
     * Get channel status
     * @returns {Object} Status information
     */
    getStatus() {
        return {
            name: this.name,
            enabled: this.enabled,
            configured: this.validateConfig(),
            supportsRelay: this.supportsRelay()
        };
    }
}

module.exports = NotificationChannel;