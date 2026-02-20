#!/usr/bin/env node

/**
 * Smart Command Injector - Multiple methods to ensure commands reach Claude Code
 */

import { exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

interface LoggerLike {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug?: (...args: unknown[]) => void;
}

interface InjectionResult {
    success: boolean;
    error?: string;
    message?: string;
}

class SmartInjector {
    log: LoggerLike;
    tempDir: string;

    constructor(logger?: LoggerLike) {
        this.log = logger || console;
        this.tempDir = path.join(__dirname, '../temp');
        this.ensureTempDir();
    }

    ensureTempDir(): void {
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    async injectCommand(token: string, command: string): Promise<boolean> {
        this.log.info(`Smart command injection: ${command.slice(0, 50)}...`);

        const methods = [
            this.tryAppleScriptInjection.bind(this),
            this.tryFileDropInjection.bind(this),
            this.tryClipboardWithPersistentNotification.bind(this),
            this.tryUrgentClipboard.bind(this)
        ];

        for (let i = 0; i < methods.length; i++) {
            const methodName = ['AppleScript Auto-injection', 'File Drag Injection', 'Persistent Notification Injection', 'Emergency Clipboard'][i];

            try {
                this.log.info(`Trying method ${i + 1}: ${methodName}`);
                const result = await methods[i](token, command);

                if (result.success) {
                    this.log.info(`${methodName} successful: ${result.message}`);
                    return true;
                } else {
                    this.log.warn(`${methodName} failed: ${result.error}`);
                }
            } catch (error: unknown) {
                this.log.error(`${methodName} exception: ${(error as Error).message}`);
            }
        }

        this.log.error('All injection methods failed');
        return false;
    }

    // Method 1: AppleScript Auto-injection
    async tryAppleScriptInjection(token: string, command: string): Promise<InjectionResult> {
        return new Promise((resolve) => {
            // First copy to clipboard
            this.copyToClipboard(command).then(() => {
                const script = `
                tell application "System Events"
                    set targetApps to {"Claude", "Claude Code", "Terminal", "iTerm2", "iTerm"}
                    set targetApp to null

                    repeat with appName in targetApps
                        try
                            if application process appName exists then
                                set targetApp to application process appName
                                exit repeat
                            end if
                        end try
                    end repeat

                    if targetApp is not null then
                        set frontmost of targetApp to true
                        delay 0.5
                        keystroke "v" using command down
                        delay 0.3
                        keystroke return
                        return "success"
                    else
                        return "no_target"
                    end if
                end tell
                `;

                exec(`osascript -e '${script}'`, (error: Error | null, stdout: string) => {
                    if (error) {
                        if (error.message.includes('1002') || error.message.includes('not allowed')) {
                            resolve({ success: false, error: 'permission_denied' });
                        } else {
                            resolve({ success: false, error: error.message });
                        }
                    } else {
                        const result = stdout.trim();
                        if (result === 'success') {
                            resolve({ success: true, message: 'Auto-paste successful' });
                        } else {
                            resolve({ success: false, error: result });
                        }
                    }
                });
            });
        });
    }

    // Method 2: File Drag Injection
    async tryFileDropInjection(token: string, command: string): Promise<InjectionResult> {
        return new Promise((resolve) => {
            try {
                // Create temporary command file
                const fileName = `taskping-command-${token}.txt`;
                const filePath = path.join(this.tempDir, fileName);

                fs.writeFileSync(filePath, command);

                // Copy file path to clipboard
                this.copyToClipboard(filePath).then(() => {
                    // Send notification to guide user
                    const notificationScript = `
                        display notification "Command file created and path copied to clipboard!\\n1. Press Cmd+G in Finder and paste path\\n2. Drag file to Claude Code window" with title "TaskPing File Injection" subtitle "Drag file: ${fileName}" sound name "Glass"
                    `;

                    exec(`osascript -e '${notificationScript}'`, () => {
                        // Try to automatically open Finder to target directory
                        exec(`open "${this.tempDir}"`, () => {
                            resolve({ success: true, message: 'File created, notification sent' });
                        });
                    });
                });

            } catch (error: unknown) {
                resolve({ success: false, error: (error as Error).message });
            }
        });
    }

    // Method 3: Persistent Notification Injection
    async tryClipboardWithPersistentNotification(token: string, command: string): Promise<InjectionResult> {
        return new Promise((resolve) => {
            this.copyToClipboard(command).then(() => {
                // Send multiple notifications to ensure user sees them
                const notifications = [
                    { delay: 0, sound: 'Basso', message: 'Email command copied! Please paste immediately to Claude Code (Cmd+V)' },
                    { delay: 3000, sound: 'Ping', message: 'Reminder: Command still in clipboard, please paste and execute' },
                    { delay: 8000, sound: 'Purr', message: 'Final reminder: Press Cmd+V in Claude Code to paste command' }
                ];

                let completedNotifications = 0;

                notifications.forEach((notif, index) => {
                    setTimeout(() => {
                        const script = `
                            display notification "${notif.message}" with title "TaskPing Persistent Reminder ${index + 1}/3" subtitle "${command.slice(0, 30)}..." sound name "${notif.sound}"
                        `;

                        exec(`osascript -e '${script}'`, () => {
                            completedNotifications++;
                            if (completedNotifications === notifications.length) {
                                resolve({ success: true, message: 'Persistent notification sequence completed' });
                            }
                        });
                    }, notif.delay);
                });

            }).catch((error: Error) => {
                resolve({ success: false, error: error.message });
            });
        });
    }

    // Method 4: Emergency Clipboard (last resort)
    async tryUrgentClipboard(token: string, command: string): Promise<InjectionResult> {
        return new Promise((resolve) => {
            this.copyToClipboard(command).then(() => {
                // Create desktop shortcut file
                const desktopPath = path.join(os.homedir(), 'Desktop');
                const shortcutContent = `#!/bin/bash
echo "TaskPing Command: ${command}"
echo "Copied to clipboard, please press Cmd+V in Claude Code to paste"
echo "${command}" | pbcopy
echo "Command refreshed to clipboard"
`;

                const shortcutPath = path.join(desktopPath, `TaskPing-${token}.command`);

                try {
                    fs.writeFileSync(shortcutPath, shortcutContent);
                    fs.chmodSync(shortcutPath, '755'); // Executable permission

                    const script = `
                        display notification "Emergency Mode: Desktop shortcut file TaskPing-${token}.command created\\nDouble-click to re-copy command to clipboard" with title "TaskPing Emergency Mode" subtitle "Command: ${command.slice(0, 20)}..." sound name "Sosumi"
                    `;

                    exec(`osascript -e '${script}'`, () => {
                        resolve({ success: true, message: 'Emergency mode: Desktop shortcut file created' });
                    });

                } catch (error: unknown) {
                    resolve({ success: false, error: (error as Error).message });
                }

            }).catch((error: Error) => {
                resolve({ success: false, error: error.message });
            });
        });
    }

    // Helper method: Copy to clipboard
    async copyToClipboard(text: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const pbcopy = spawn('pbcopy');
            pbcopy.stdin.write(text);
            pbcopy.stdin.end();

            pbcopy.on('close', (code: number | null) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`pbcopy failed with code ${code}`));
                }
            });
        });
    }

    // Clean up temporary files
    cleanup(): void {
        try {
            if (fs.existsSync(this.tempDir)) {
                const files = fs.readdirSync(this.tempDir);
                const now = Date.now();

                files.forEach(file => {
                    const filePath = path.join(this.tempDir, file);
                    const stats = fs.statSync(filePath);
                    const age = now - stats.mtime.getTime();

                    // Delete temporary files older than 1 hour
                    if (age > 60 * 60 * 1000) {
                        fs.unlinkSync(filePath);
                    }
                });
            }
        } catch (error: unknown) {
            this.log.warn(`Failed to clean up temporary files: ${(error as Error).message}`);
        }
    }
}

export = SmartInjector;
