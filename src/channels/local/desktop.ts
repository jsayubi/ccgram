/**
 * Desktop Notification Channel
 * Sends notifications to the local desktop
 */

import NotificationChannel from '../base/channel';
import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import type { Notification } from '../../types';

interface DesktopConfig {
    enabled?: boolean;
    completedSound?: string;
    waitingSound?: string;
    [key: string]: unknown;
}

interface SoundCategories {
    [category: string]: string[];
}

class DesktopChannel extends NotificationChannel {
    platform: string;
    soundsDir: string;

    constructor(config: DesktopConfig = {} as DesktopConfig) {
        super('desktop', config);
        this.platform = process.platform;
        this.soundsDir = path.join(__dirname, '../../assets/sounds');
    }

    async _sendImpl(notification: Notification): Promise<boolean> {
        const { title, message } = notification;
        const sound = this._getSoundForType(notification.type);

        switch (this.platform) {
            case 'darwin':
                return this._sendMacOS(title, message, sound);
            case 'linux':
                return this._sendLinux(title, message, sound);
            case 'win32':
                return this._sendWindows(title, message, sound);
            default:
                this.logger.warn(`Platform ${this.platform} not supported`);
                return false;
        }
    }

    _getSoundForType(type: string): string {
        const config = this.config as DesktopConfig;
        const soundMap: Record<string, string> = {
            completed: config.completedSound || 'Glass',
            waiting: config.waitingSound || 'Tink'
        };
        return soundMap[type] || 'Glass';
    }

    _sendMacOS(title: string, message: string, sound: string): boolean {
        try {
            // Try terminal-notifier first
            try {
                const cmd = `terminal-notifier -title "${title}" -message "${message}" -sound "${sound}" -group "ccgram"`;
                execSync(cmd, { timeout: parseInt(process.env.NOTIFICATION_TIMEOUT as string) || 3000 });
                return true;
            } catch (e: unknown) {
                // Fallback to osascript
                const script = `display notification "${message}" with title "${title}"`;
                execSync(`osascript -e '${script}'`, { timeout: parseInt(process.env.NOTIFICATION_TIMEOUT as string) || 3000 });

                // Play sound separately
                this._playSound(sound);
                return true;
            }
        } catch (error: unknown) {
            this.logger.error('macOS notification failed:', (error as Error).message);
            return false;
        }
    }

    _sendLinux(title: string, message: string, sound: string): boolean {
        try {
            const notificationTimeout = parseInt(process.env.NOTIFICATION_TIMEOUT as string) || 3000;
            const displayTime = parseInt(process.env.NOTIFICATION_DISPLAY_TIME as string) || 10000;
            execSync(`notify-send "${title}" "${message}" -t ${displayTime}`, { timeout: notificationTimeout });
            this._playSound(sound);
            return true;
        } catch (error: unknown) {
            this.logger.error('Linux notification failed:', (error as Error).message);
            return false;
        }
    }

    _sendWindows(title: string, message: string, sound: string): boolean {
        try {
            const script = `
            [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
            $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
            $xml = [xml] $template.GetXml()
            $xml.toast.visual.binding.text[0].AppendChild($xml.CreateTextNode("${title}")) > $null
            $xml.toast.visual.binding.text[1].AppendChild($xml.CreateTextNode("${message}")) > $null
            $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
            [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("CCGram").Show($toast)
            `;

            execSync(`powershell -Command "${script}"`, { timeout: 5000 });
            this._playSound(sound);
            return true;
        } catch (error: unknown) {
            this.logger.error('Windows notification failed:', (error as Error).message);
            return false;
        }
    }

    _playSound(soundName: string): void {
        if (!soundName || soundName === 'default') return;

        try {
            if (this.platform === 'darwin') {
                const soundPath = `/System/Library/Sounds/${soundName}.aiff`;
                const audioProcess = spawn('afplay', [soundPath], {
                    detached: true,
                    stdio: 'ignore'
                });
                audioProcess.unref();
            } else if (this.platform === 'linux') {
                const soundPath = `/usr/share/sounds/freedesktop/stereo/${soundName.toLowerCase()}.oga`;
                const audioProcess = spawn('paplay', [soundPath], {
                    detached: true,
                    stdio: 'ignore'
                });
                audioProcess.unref();
            } else if (this.platform === 'win32') {
                const audioProcess = spawn('powershell', ['-c', `[console]::beep(800,300)`], {
                    detached: true,
                    stdio: 'ignore'
                });
                audioProcess.unref();
            }
        } catch (error: unknown) {
            this.logger.debug('Sound playback failed:', (error as Error).message);
        }
    }

    validateConfig(): boolean {
        // Desktop notifications don't require configuration
        return true;
    }

    getAvailableSounds(): SoundCategories {
        const sounds: SoundCategories = {
            'System Sounds': ['Glass', 'Tink', 'Ping', 'Pop', 'Basso', 'Blow', 'Bottle',
                            'Frog', 'Funk', 'Hero', 'Morse', 'Purr', 'Sosumi', 'Submarine'],
            'Alert Sounds': ['Beep', 'Boop', 'Sosumi', 'Tink', 'Glass'],
            'Nature Sounds': ['Frog', 'Submarine'],
            'Musical Sounds': ['Funk', 'Hero', 'Morse', 'Sosumi']
        };

        // Add custom sounds from assets directory
        try {
            if (fs.existsSync(this.soundsDir)) {
                const customSounds = fs.readdirSync(this.soundsDir)
                    .filter(file => /\.(wav|mp3|m4a|aiff|ogg)$/i.test(file))
                    .map(file => path.basename(file, path.extname(file)));

                if (customSounds.length > 0) {
                    sounds['Custom Sounds'] = customSounds;
                }
            }
        } catch (error: unknown) {
            this.logger.debug('Failed to load custom sounds:', (error as Error).message);
        }

        return sounds;
    }
}

export = DesktopChannel;
