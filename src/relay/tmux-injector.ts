#!/usr/bin/env node

/**
 * Tmux Command Injector - Unattended remote control solution
 */

import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

interface Logger {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
}

interface InjectionResult {
    success: boolean;
    error?: string;
    message?: string;
    session?: string;
}

interface CaptureResult {
    success: boolean;
    output?: string;
    error?: string;
}

interface SessionInfo {
    exists: boolean;
    info?: string;
    name?: string;
}

class TmuxInjector {
    log: Logger;
    sessionName: string;
    logFile: string;

    constructor(logger?: Logger, sessionName: string | null = null) {
        this.log = logger || console;
        this.sessionName = sessionName || 'claude-taskping';
        this.logFile = path.join(__dirname, '../logs/tmux-injection.log');
        this.ensureLogDir();
    }

    ensureLogDir(): void {
        const logDir = path.dirname(this.logFile);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
    }

    // Check if tmux is installed
    async checkTmuxAvailable(): Promise<boolean> {
        return new Promise((resolve) => {
            exec('which tmux', (error) => {
                resolve(!error);
            });
        });
    }

    // Check if Claude tmux session exists
    async checkClaudeSession(): Promise<boolean> {
        return new Promise((resolve) => {
            exec(`tmux has-session -t ${this.sessionName} 2>/dev/null`, (error) => {
                resolve(!error);
            });
        });
    }

    // Create Claude tmux session
    async createClaudeSession(): Promise<InjectionResult> {
        return new Promise((resolve) => {
            // Use clauderun command to start Claude (without pre-filling any commands)
            const command = `tmux new-session -d -s ${this.sessionName} -c "${process.cwd()}" clauderun`;

            this.log.info(`Creating tmux session with clauderun command: ${command}`);

            exec(command, (error, stdout, stderr) => {
                if (error) {
                    this.log.warn(`Failed to create tmux session with clauderun: ${error.message}`);
                    // If clauderun fails, try using full path command
                    this.log.info('Fallback to full path command...');
                    const claudePath = process.env.CLAUDE_CLI_PATH || 'claude';
                    const fallbackCommand = `tmux new-session -d -s ${this.sessionName} -c "${process.cwd()}" ${claudePath} --dangerously-skip-permissions`;

                    exec(fallbackCommand, (fallbackError) => {
                        if (fallbackError) {
                            this.log.error(`Failed to create tmux session with fallback: ${fallbackError.message}`);
                            resolve({ success: false, error: fallbackError.message });
                        } else {
                            this.log.info('Tmux Claude session created successfully (full path)');
                            setTimeout(() => {
                                resolve({ success: true });
                            }, 3000);
                        }
                    });
                } else {
                    this.log.info('Tmux Claude session created successfully (clauderun)');
                    // Wait for Claude initialization
                    setTimeout(() => {
                        resolve({ success: true });
                    }, 3000);
                }
            });
        });
    }

    // Inject command into tmux session (intelligently handle Claude confirmations)
    async injectCommand(command: string): Promise<InjectionResult> {
        return new Promise(async (resolve) => {
            try {
                // 1. Clear input field
                const clearCommand = `tmux send-keys -t ${this.sessionName} C-u`;

                // 2. Send command
                const escapedCommand = command.replace(/'/g, "'\"'\"'");
                const sendCommand = `tmux send-keys -t ${this.sessionName} '${escapedCommand}'`;

                // 3. Send enter
                const enterCommand = `tmux send-keys -t ${this.sessionName} C-m`;

                this.log.debug(`Injecting command via tmux: ${command}`);

                // Execute three steps
                exec(clearCommand, (clearError) => {
                    if (clearError) {
                        this.log.error(`Failed to clear input: ${clearError.message}`);
                        resolve({ success: false, error: clearError.message });
                        return;
                    }

                    // Brief wait
                    setTimeout(() => {
                        exec(sendCommand, (sendError) => {
                            if (sendError) {
                                this.log.error(`Failed to send command: ${sendError.message}`);
                                resolve({ success: false, error: sendError.message });
                                return;
                            }

                            // Brief wait
                            setTimeout(() => {
                                exec(enterCommand, async (enterError) => {
                                    if (enterError) {
                                        this.log.error(`Failed to send enter: ${enterError.message}`);
                                        resolve({ success: false, error: enterError.message });
                                        return;
                                    }

                                    this.log.debug('Command sent successfully in 3 steps');

                                    // Brief wait for command sending
                                    await new Promise<void>(r => setTimeout(r, 1000));

                                    // Check if command is already displayed in Claude
                                    const capture = await this.getCaptureOutput();
                                    if (capture.success) {
                                        this.log.debug(`Claude state after injection: ${capture.output!.slice(-200).replace(/\n/g, ' ')}`);
                                    }

                                    // Wait and check if confirmation is needed
                                    await this.handleConfirmations();

                                    // Record injection log
                                    this.logInjection(command);

                                    resolve({ success: true });
                                });
                            }, 200);
                        });
                    }, 200);
                });

            } catch (error) {
                resolve({ success: false, error: (error as Error).message });
            }
        });
    }

    // Automatically handle Claude confirmation dialogs
    async handleConfirmations(): Promise<void> {
        const maxAttempts = 8;
        let attempts = 0;

        while (attempts < maxAttempts) {
            attempts++;

            // Wait for Claude processing
            await new Promise<void>(resolve => setTimeout(resolve, 1500));

            // Get current screen content
            const capture = await this.getCaptureOutput();

            if (!capture.success) {
                break;
            }

            const output = capture.output!;
            this.log.debug(`Confirmation check ${attempts}: ${output.slice(-200).replace(/\n/g, ' ')}`);

            // Check for multi-option confirmation dialog (priority handling)
            if (output.includes('Do you want to proceed?') &&
                (output.includes('1. Yes') || output.includes('2. Yes, and don\'t ask again'))) {

                this.log.info(`Detected multi-option confirmation, selecting option 2 (attempt ${attempts})`);

                // Select "2. Yes, and don't ask again" to avoid future confirmation dialogs
                await new Promise<void>((resolve) => {
                    exec(`tmux send-keys -t ${this.sessionName} '2'`, (error) => {
                        if (error) {
                            this.log.warn('Failed to send option 2');
                        } else {
                            this.log.info('Auto-confirmation sent (option 2)');
                            // Send Enter key
                            setTimeout(() => {
                                exec(`tmux send-keys -t ${this.sessionName} 'Enter'`, (enterError) => {
                                    if (enterError) {
                                        this.log.warn('Failed to send Enter after option 2');
                                    } else {
                                        this.log.info('Enter sent after option 2 - no future dialogs');
                                    }
                                    resolve();
                                });
                            }, 300);
                        }
                    });
                });

                // Wait for confirmation to take effect
                await new Promise<void>(resolve => setTimeout(resolve, 2000));
                continue;
            }

            // Check for single option confirmation
            if (output.includes('❯ 1. Yes') || output.includes('▷ 1. Yes')) {
                this.log.info(`Detected single option confirmation, selecting option 1 (attempt ${attempts})`);

                await new Promise<void>((resolve) => {
                    exec(`tmux send-keys -t ${this.sessionName} '1'`, (error) => {
                        if (error) {
                            this.log.warn('Failed to send option 1');
                        } else {
                            this.log.info('Auto-confirmation sent (option 1)');
                            // Send Enter key
                            setTimeout(() => {
                                exec(`tmux send-keys -t ${this.sessionName} 'Enter'`, (enterError) => {
                                    if (enterError) {
                                        this.log.warn('Failed to send Enter after option 1');
                                    } else {
                                        this.log.info('Enter sent after option 1');
                                    }
                                    resolve();
                                });
                            }, 300);
                        }
                    });
                });

                continue;
            }

            // Check for simple Y/N confirmation
            if (output.includes('(y/n)') || output.includes('[Y/n]') || output.includes('[y/N]')) {
                this.log.info(`Detected y/n prompt, sending 'y' (attempt ${attempts})`);

                await new Promise<void>((resolve) => {
                    exec(`tmux send-keys -t ${this.sessionName} 'y'`, (error) => {
                        if (error) {
                            this.log.warn('Failed to send y');
                        } else {
                            this.log.info('Auto-confirmation sent (y)');
                            // Send Enter key
                            setTimeout(() => {
                                exec(`tmux send-keys -t ${this.sessionName} 'Enter'`, (enterError) => {
                                    if (enterError) {
                                        this.log.warn('Failed to send Enter after y');
                                    } else {
                                        this.log.info('Enter sent after y');
                                    }
                                    resolve();
                                });
                            }, 300);
                        }
                    });
                });

                continue;
            }

            // Check for press Enter to continue prompts
            if (output.includes('Press Enter to continue') ||
                output.includes('Enter to confirm') ||
                output.includes('Press Enter')) {
                this.log.info(`Detected Enter prompt, sending Enter (attempt ${attempts})`);

                await new Promise<void>((resolve) => {
                    exec(`tmux send-keys -t ${this.sessionName} 'Enter'`, (error) => {
                        if (error) {
                            this.log.warn('Failed to send Enter');
                        } else {
                            this.log.info('Auto-Enter sent');
                        }
                        resolve();
                    });
                });

                continue;
            }

            // Check if command is currently executing
            if (output.includes('Clauding…') ||
                output.includes('Waiting…') ||
                output.includes('Processing…') ||
                output.includes('Working…')) {
                this.log.info('Command appears to be executing, waiting...');
                continue;
            }

            // Check for new empty input box (indicates completion)
            if ((output.includes('│ >') || output.includes('> ')) &&
                !output.includes('Do you want to proceed?') &&
                !output.includes('1. Yes') &&
                !output.includes('(y/n)')) {
                this.log.debug('New input prompt detected, command likely completed');
                break;
            }

            // Check for error messages
            if (output.includes('Error:') || output.includes('error:') || output.includes('failed')) {
                this.log.warn('Detected error in output, stopping confirmation attempts');
                break;
            }

            // If nothing detected, wait longer before checking again
            if (attempts < maxAttempts) {
                this.log.info('No confirmation prompts detected, waiting longer...');
                await new Promise<void>(resolve => setTimeout(resolve, 2000));
            }
        }

        this.log.info(`Confirmation handling completed after ${attempts} attempts`);

        // Final state check
        const finalCapture = await this.getCaptureOutput();
        if (finalCapture.success) {
            this.log.debug(`Final state: ${finalCapture.output!.slice(-100).replace(/\n/g, ' ')}`);
        }
    }

    // Get tmux session output
    async getCaptureOutput(): Promise<CaptureResult> {
        return new Promise((resolve) => {
            const command = `tmux capture-pane -t ${this.sessionName} -p`;

            exec(command, (error, stdout, stderr) => {
                if (error) {
                    resolve({ success: false, error: error.message });
                } else {
                    resolve({ success: true, output: stdout });
                }
            });
        });
    }

    // Restart Claude session
    async restartClaudeSession(): Promise<InjectionResult> {
        return new Promise(async (resolve) => {
            this.log.info('Restarting Claude tmux session...');

            // Kill existing session
            exec(`tmux kill-session -t ${this.sessionName} 2>/dev/null`, async () => {
                // Wait a moment
                await new Promise<void>(r => setTimeout(r, 1000));

                // Create new session
                const result = await this.createClaudeSession();
                resolve(result);
            });
        });
    }

    // Complete command injection workflow
    async injectCommandFull(token: string, command: string): Promise<InjectionResult> {
        try {
            this.log.debug(`Starting tmux command injection (Token: ${token})`);

            // 1. Check if tmux is available
            const tmuxAvailable = await this.checkTmuxAvailable();
            if (!tmuxAvailable) {
                return { success: false, error: 'tmux_not_installed', message: 'Need to install tmux: brew install tmux' };
            }

            // 2. Check if Claude session exists
            const sessionExists = await this.checkClaudeSession();

            if (!sessionExists) {
                this.log.warn('Claude tmux session not found, creating new session...');
                const createResult = await this.createClaudeSession();

                if (!createResult.success) {
                    return { success: false, error: 'session_creation_failed', message: createResult.error };
                }
            }

            // 3. Inject command
            const injectResult = await this.injectCommand(command);

            if (injectResult.success) {
                // 4. Send success notification
                await this.sendSuccessNotification(command);

                return {
                    success: true,
                    message: 'Command successfully injected into Claude tmux session',
                    session: this.sessionName
                };
            } else {
                return {
                    success: false,
                    error: 'injection_failed',
                    message: injectResult.error
                };
            }

        } catch (error) {
            this.log.error(`Tmux injection error: ${(error as Error).message}`);
            return { success: false, error: 'unexpected_error', message: (error as Error).message };
        }
    }

    // Send success notification
    async sendSuccessNotification(command: string): Promise<void> {
        const shortCommand = command.length > 30 ? command.substring(0, 30) + '...' : command;
        const notificationScript = `
            display notification "🎉 Command automatically injected into Claude! No manual operation needed" with title "TaskPing Remote Control Success" subtitle "${shortCommand.replace(/"/g, '\\"')}" sound name "Glass"
        `;

        exec(`osascript -e '${notificationScript}'`, (error) => {
            if (error) {
                this.log.warn('Failed to send success notification');
            } else {
                this.log.info('Success notification sent');
            }
        });
    }

    // Record injection log
    logInjection(command: string): void {
        const logEntry = {
            timestamp: new Date().toISOString(),
            command: command,
            session: this.sessionName,
            pid: process.pid
        };

        const logLine = JSON.stringify(logEntry) + '\n';

        try {
            fs.appendFileSync(this.logFile, logLine);
        } catch (error) {
            this.log.warn(`Failed to write injection log: ${(error as Error).message}`);
        }
    }

    // Get session status information
    async getSessionInfo(): Promise<SessionInfo> {
        return new Promise((resolve) => {
            const command = `tmux list-sessions | grep ${this.sessionName}`;

            exec(command, (error, stdout, stderr) => {
                if (error) {
                    resolve({ exists: false });
                } else {
                    const sessionInfo = stdout.trim();
                    resolve({
                        exists: true,
                        info: sessionInfo,
                        name: this.sessionName
                    });
                }
            });
        });
    }
}

export = TmuxInjector;
