/**
 * CCGram Core Notifier
 * Central notification orchestrator that manages multiple channels
 */

import Logger from './logger';
import ConfigManager from './config';
import type { Notification } from '../types';

interface NotificationChannel {
    enabled: boolean;
    send(notification: Notification): Promise<boolean>;
    test(): Promise<boolean>;
    getStatus(): Record<string, unknown>;
}

interface I18nContent {
    title: string;
    message: string;
}

interface I18nLang {
    completed: I18nContent;
    waiting: I18nContent;
    [type: string]: I18nContent;
}

interface I18nData {
    [lang: string]: I18nLang;
}

interface ChannelResult {
    name: string;
    success: boolean;
    error?: string;
    reason?: string;
}

class Notifier {
    logger: Logger;
    config: ConfigManager;
    channels: Map<string, NotificationChannel>;
    i18n: I18nData | null;

    constructor(configManager: ConfigManager | null = null) {
        this.logger = new Logger('Notifier');
        this.config = configManager || new ConfigManager();
        this.channels = new Map();
        this.i18n = null;

        this._loadI18n();
    }

    registerChannel(name: string, channel: NotificationChannel): void {
        this.logger.debug(`Registering channel: ${name}`);
        this.channels.set(name, channel);
    }

    async initializeChannels(): Promise<void> {
        this.logger.debug('Initializing channels...');

        // Load desktop channel
        const DesktopChannel = require('../channels/local/desktop');
        const desktopConfig = this.config.getChannel('desktop');
        if (desktopConfig && desktopConfig.enabled) {
            const desktop = new DesktopChannel(desktopConfig.config || {});
            desktop.config.completedSound = this.config.get('sound.completed');
            desktop.config.waitingSound = this.config.get('sound.waiting');
            this.registerChannel('desktop', desktop);
        }

        // Load email channel
        const EmailChannel = require('../channels/email/smtp');
        const emailConfig = this.config.getChannel('email');
        if (emailConfig && emailConfig.enabled) {
            const email = new EmailChannel(emailConfig.config || {});
            this.registerChannel('email', email);
        }

        // Load LINE channel
        const LINEChannel = require('../channels/line/line');
        const lineConfig = this.config.getChannel('line');
        if (lineConfig && lineConfig.enabled) {
            const line = new LINEChannel(lineConfig.config || {});
            this.registerChannel('line', line);
        }

        // Load Telegram channel
        const TelegramChannel = require('../channels/telegram/telegram');
        const telegramConfig = this.config.getChannel('telegram');
        if (telegramConfig && telegramConfig.enabled) {
            const telegram = new TelegramChannel(telegramConfig.config || {});
            this.registerChannel('telegram', telegram);
        }

        this.logger.info(`Initialized ${this.channels.size} channels`);
    }

    async notify(type: string, metadata: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
        if (!this.config.get('enabled', true)) {
            this.logger.debug('Notifications disabled');
            return { success: false, reason: 'disabled' };
        }

        const notification = this._buildNotification(type, metadata);
        this.logger.info(`Sending ${type} notification for project: ${notification.project}`);

        const results: Record<string, ChannelResult> = {};
        const promises: Promise<ChannelResult>[] = [];

        // Send to all channels in parallel
        for (const [name, channel] of this.channels) {
            if (channel.enabled) {
                promises.push(
                    channel.send(notification)
                        .then((success: boolean) => ({ name, success }))
                        .catch((error: Error) => ({ name, success: false, error: error.message }))
                );
            } else {
                results[name] = { name, success: false, reason: 'disabled' };
            }
        }

        // Wait for all channels to complete
        const channelResults = await Promise.all(promises);
        channelResults.forEach(result => {
            results[result.name] = result;
        });

        const successCount = Object.values(results).filter(r => r.success).length;
        this.logger.info(`Notification sent to ${successCount}/${this.channels.size} channels`);

        return {
            success: successCount > 0,
            results,
            notification
        };
    }

    _buildNotification(type: string, metadata: Record<string, unknown> = {}): Notification {
        const project = (metadata.project as string) || this.config.getProjectName();
        const lang = this.config.get('language', 'zh-CN') as string;
        const content = this._getNotificationContent(type, lang);

        // Replace project placeholder
        const message = content.message.replace('{project}', project);

        // Use custom message if configured
        const customMessage = this.config.get(`customMessages.${type}`) as string | null;
        const finalMessage = customMessage ? customMessage.replace('{project}', project) : message;

        return {
            type,
            title: content.title,
            message: finalMessage,
            project,
            metadata: {
                timestamp: new Date().toISOString(),
                language: lang,
                ...metadata
            }
        };
    }

    _getNotificationContent(type: string, lang: string): I18nContent {
        if (!this.i18n) {
            this._loadI18n();
        }

        const langData = this.i18n![lang] || this.i18n!['en'];
        return langData[type] || langData.completed;
    }

    _loadI18n(): void {
        this.i18n = {
            'zh-CN': {
                completed: {
                    title: 'Claude Code - Task Completed',
                    message: '[{project}] Task completed, Claude is waiting for next instruction'
                },
                waiting: {
                    title: 'Claude Code - Waiting for Input',
                    message: '[{project}] Claude needs your further guidance'
                }
            },
            'en': {
                completed: {
                    title: 'Claude Code - Task Completed',
                    message: '[{project}] Task completed, Claude is waiting for next instruction'
                },
                waiting: {
                    title: 'Claude Code - Waiting for Input',
                    message: '[{project}] Claude needs your further guidance'
                }
            },
            'ja': {
                completed: {
                    title: 'Claude Code - Task Completed',
                    message: '[{project}] Task completed, Claude is waiting for next instruction'
                },
                waiting: {
                    title: 'Claude Code - Waiting for Input',
                    message: '[{project}] Claude needs your further guidance'
                }
            }
        };
    }

    async test(): Promise<Record<string, { success: boolean; error?: string }>> {
        this.logger.info('Testing all channels...');

        const results: Record<string, { success: boolean; error?: string }> = {};
        for (const [name, channel] of this.channels) {
            try {
                const success = await channel.test();
                results[name] = { success };
                this.logger.info(`Channel ${name}: ${success ? 'PASS' : 'FAIL'}`);
            } catch (error: unknown) {
                results[name] = { success: false, error: (error as Error).message };
                this.logger.error(`Channel ${name}: ERROR - ${(error as Error).message}`);
            }
        }

        return results;
    }

    getStatus(): Record<string, unknown> {
        const channels: Record<string, Record<string, unknown>> = {};
        for (const [name, channel] of this.channels) {
            channels[name] = channel.getStatus();
        }

        return {
            enabled: this.config.get('enabled', true),
            channels,
            config: {
                language: this.config.get('language'),
                sound: this.config.get('sound'),
                customMessages: this.config.get('customMessages')
            }
        };
    }
}

export = Notifier;
