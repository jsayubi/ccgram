/**
 * Command Relay Service
 * Manages email listening and command execution for Claude Code
 */

import EventEmitter from 'events';
import EmailListener from './email-listener';
import ClaudeCommandBridge from './claude-command-bridge';
import Logger from '../core/logger';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

// Automation classes are not yet migrated to TypeScript
const ClipboardAutomation = require('../automation/clipboard-automation') as any;
const SimpleAutomation = require('../automation/simple-automation') as any;
const ClaudeAutomation = require('../automation/claude-automation') as any;

interface RelayConfig {
    imap?: {
        auth: { user: string; pass: string };
        host: string;
        port: number;
        secure: boolean;
    };
    sentMessagesPath?: string;
    template?: { checkInterval?: number };
    [key: string]: unknown;
}

interface CommandData {
    sessionId: string;
    command: string;
    [key: string]: unknown;
}

interface QueueItem extends CommandData {
    id: string;
    queuedAt: string;
    status: string;
    retries: number;
    maxRetries: number;
    executedAt?: string;
    completedAt?: string;
    failedAt?: string;
    error?: string;
    retryAt?: string;
}

interface ClaudeProcess {
    pid: number | null;
    command?: string;
    available?: boolean;
}

interface RelayState {
    commandQueue: QueueItem[];
    lastSaved: string;
}

interface RelayStatus {
    isRunning: boolean;
    queueLength: number;
    processing: boolean;
    emailListener: { connected: boolean; listening: boolean } | null;
    recentCommands: Array<{ id: string; status: string; queuedAt: string; command: string }>;
}

class CommandRelayService extends EventEmitter {
    logger: Logger;
    config: RelayConfig;
    emailListener: EmailListener | null;
    commandBridge: ClaudeCommandBridge;
    clipboardAutomation: any;
    simpleAutomation: any;
    claudeAutomation: any;
    isRunning: boolean;
    commandQueue: QueueItem[];
    processingQueue: boolean;
    stateFile: string;

    constructor(config: RelayConfig) {
        super();
        this.logger = new Logger('CommandRelay');
        this.config = config;
        this.emailListener = null;
        this.commandBridge = new ClaudeCommandBridge();
        this.clipboardAutomation = new ClipboardAutomation();
        this.simpleAutomation = new SimpleAutomation();
        this.claudeAutomation = new ClaudeAutomation();
        this.isRunning = false;
        this.commandQueue = [];
        this.processingQueue = false;
        this.stateFile = path.join(__dirname, '../data/relay-state.json');

        this._ensureDirectories();
        this._loadState();
    }

    _ensureDirectories(): void {
        const dataDir = path.join(__dirname, '../data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
    }

    _loadState(): void {
        try {
            if (fs.existsSync(this.stateFile)) {
                const state: RelayState = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
                this.commandQueue = state.commandQueue || [];
                this.logger.debug(`Loaded ${this.commandQueue.length} queued commands`);
            }
        } catch (error: unknown) {
            this.logger.warn('Failed to load relay state:', (error as Error).message);
            this.commandQueue = [];
        }
    }

    _saveState(): void {
        try {
            const state: RelayState = {
                commandQueue: this.commandQueue,
                lastSaved: new Date().toISOString()
            };
            fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
        } catch (error: unknown) {
            this.logger.error('Failed to save relay state:', (error as Error).message);
        }
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            this.logger.warn('Command relay service already running');
            return;
        }

        try {
            // Validate email configuration
            if (!this.config.imap) {
                throw new Error('IMAP configuration required for command relay');
            }

            // Start email listener
            this.emailListener = new EmailListener(this.config);

            // Listen for command events
            this.emailListener.on('command', (commandData: CommandData) => {
                this._queueCommand(commandData);
            });

            // Start email listening
            await this.emailListener.start();

            // Start command processing
            this._startCommandProcessor();

            this.isRunning = true;
            this.logger.info('Command relay service started successfully');

            // Send startup notification
            this.emit('started');

        } catch (error: unknown) {
            this.logger.error('Failed to start command relay service:', (error as Error).message);
            throw error;
        }
    }

    async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;

        // Stop email listener
        if (this.emailListener) {
            await this.emailListener.stop();
            this.emailListener = null;
        }

        // Save state
        this._saveState();

        this.logger.info('Command relay service stopped');
        this.emit('stopped');
    }

    _queueCommand(commandData: CommandData): void {
        const queueItem: QueueItem = {
            id: this._generateId(),
            ...commandData,
            queuedAt: new Date().toISOString(),
            status: 'queued',
            retries: 0,
            maxRetries: 3
        };

        this.commandQueue.push(queueItem);
        this._saveState();

        this.logger.info(`Command queued:`, {
            id: queueItem.id,
            sessionId: queueItem.sessionId,
            command: queueItem.command.substring(0, 50) + '...'
        });

        this.emit('commandQueued', queueItem);
    }

    _startCommandProcessor(): void {
        // Process queue immediately
        this._processCommandQueue();

        // Process queue periodically
        setInterval(() => {
            if (this.isRunning) {
                this._processCommandQueue();
            }
        }, 5000); // Check every 5 seconds
    }

    async _processCommandQueue(): Promise<void> {
        if (this.processingQueue || this.commandQueue.length === 0) {
            return;
        }

        this.processingQueue = true;

        try {
            const pendingCommands = this.commandQueue.filter(cmd => cmd.status === 'queued');

            for (const command of pendingCommands) {
                try {
                    await this._executeCommand(command);
                } catch (error: unknown) {
                    this.logger.error(`Failed to execute command ${command.id}:`, (error as Error).message);
                    this._handleCommandError(command, error as Error);
                }
            }
        } finally {
            this.processingQueue = false;
        }
    }

    async _executeCommand(commandItem: QueueItem): Promise<void> {
        this.logger.info(`Executing command ${commandItem.id}:`, {
            sessionId: commandItem.sessionId,
            command: commandItem.command.substring(0, 100)
        });

        commandItem.status = 'executing';
        commandItem.executedAt = new Date().toISOString();

        try {
            // Check if Claude Code process is running
            const claudeProcess = await this._findClaudeCodeProcess();

            if (!claudeProcess || !claudeProcess.available) {
                throw new Error('Claude Code not available');
            }

            // Execute command - try multiple methods
            const success = await this._sendCommandToClaudeCode(commandItem.command, claudeProcess, commandItem.sessionId);

            if (success) {
                commandItem.status = 'completed';
                commandItem.completedAt = new Date().toISOString();

                // Update session command count
                if (this.emailListener) {
                    await this.emailListener.updateSessionCommandCount(commandItem.sessionId);
                }

                this.logger.info(`Command ${commandItem.id} executed successfully`);
                this.emit('commandExecuted', commandItem);
            } else {
                throw new Error('Failed to send command to Claude Code');
            }

        } catch (error: unknown) {
            commandItem.status = 'failed';
            commandItem.error = (error as Error).message;
            commandItem.failedAt = new Date().toISOString();

            this.logger.error(`Command ${commandItem.id} failed:`, (error as Error).message);
            this.emit('commandFailed', commandItem, error);

            throw error;
        } finally {
            this._saveState();
        }
    }

    async _findClaudeCodeProcess(): Promise<ClaudeProcess> {
        return new Promise((resolve) => {
            // Find Claude Code related processes
            const ps = spawn('ps', ['aux']);
            let output = '';

            ps.stdout.on('data', (data: Buffer) => {
                output += data.toString();
            });

            ps.on('close', (code: number | null) => {
                const lines = output.split('\n');
                const claudeProcesses = lines.filter(line =>
                    (line.includes('claude') ||
                     line.includes('anthropic') ||
                     line.includes('Claude') ||
                     line.includes('node') && line.includes('claude')) &&
                    !line.includes('grep') &&
                    !line.includes('taskping') &&
                    !line.includes('ps aux')
                );

                if (claudeProcesses.length > 0) {
                    // Parse process ID
                    const processLine = claudeProcesses[0];
                    const parts = processLine.trim().split(/\s+/);
                    const pid = parseInt(parts[1]);

                    this.logger.debug('Found Claude Code process:', processLine);
                    resolve({
                        pid,
                        command: processLine
                    });
                } else {
                    // If no process found, assume Claude Code can be accessed via desktop automation
                    this.logger.debug('No Claude Code process found, will try desktop automation');
                    resolve({ pid: null, available: true });
                }
            });

            ps.on('error', (error: Error) => {
                this.logger.error('Error finding Claude Code process:', error.message);
                // Even if error occurs, try desktop automation
                resolve({ pid: null, available: true });
            });
        });
    }

    async _sendCommandToClaudeCode(command: string, claudeProcess: ClaudeProcess, sessionId: string): Promise<boolean> {
        return new Promise(async (resolve) => {
            try {
                // Method 1: Claude Code dedicated automation (most direct and reliable)
                this.logger.info('Attempting to send command via Claude automation...');
                const claudeSuccess = await this.claudeAutomation.sendCommand(command, sessionId);

                if (claudeSuccess) {
                    this.logger.info('Command sent and executed successfully via Claude automation');
                    resolve(true);
                    return;
                }

                // Method 2: Clipboard automation (requires permissions)
                if (this.clipboardAutomation.isSupported()) {
                    this.logger.info('Attempting to send command via clipboard automation...');
                    const clipboardSuccess = await this.clipboardAutomation.sendCommand(command);

                    if (clipboardSuccess) {
                        this.logger.info('Command sent successfully via clipboard automation');
                        resolve(true);
                        return;
                    }
                    this.logger.warn('Clipboard automation failed, trying other methods...');
                }

                // Method 3: Simple automation solution (includes multiple fallback options)
                this.logger.info('Attempting to send command via simple automation...');
                const simpleSuccess = await this.simpleAutomation.sendCommand(command, sessionId);

                if (simpleSuccess) {
                    this.logger.info('Command sent successfully via simple automation');
                    resolve(true);
                    return;
                }

                // Method 4: Use command bridge (file-based approach)
                this.logger.info('Attempting to send command via bridge...');
                const bridgeSuccess = await this.commandBridge.sendCommand(command, sessionId);

                if (bridgeSuccess) {
                    this.logger.info('Command sent successfully via bridge');
                    resolve(true);
                    return;
                }

                // Method 5: Send notification as final fallback
                this.logger.info('Using notification as final fallback...');
                this._sendCommandViaNotification(command)
                    .then((success) => {
                        this.logger.info('Command notification sent as fallback');
                        resolve(success);
                    })
                    .catch(() => resolve(false));

            } catch (error: unknown) {
                this.logger.error('Error sending command to Claude Code:', (error as Error).message);
                resolve(false);
            }
        });
    }

    async _sendCommandViaMacOS(command: string): Promise<boolean> {
        return new Promise((resolve, reject) => {
            // Use AppleScript automation to input to active window
            const escapedCommand = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "\\'");
            const script = `
                tell application "System Events"
                    -- Get current active application
                    set activeApp to name of first application process whose frontmost is true

                    -- Try to find Claude Code, Terminal or other development tools
                    set targetApps to {"Claude Code", "Terminal", "iTerm2", "iTerm", "Visual Studio Code", "Code"}
                    set foundApp to null

                    repeat with appName in targetApps
                        try
                            if application process appName exists then
                                set foundApp to application process appName
                                exit repeat
                            end if
                        end try
                    end repeat

                    if foundApp is not null then
                        -- Switch to target application
                        set frontmost of foundApp to true
                        delay 1

                        -- Send command
                        keystroke "${escapedCommand}"
                        delay 0.3
                        keystroke return

                        return "success"
                    else
                        -- If no specific application found, try current active window
                        keystroke "${escapedCommand}"
                        delay 0.3
                        keystroke return
                        return "fallback"
                    end if
                end tell
            `;

            const osascript = spawn('osascript', ['-e', script]);
            let output = '';
            let errorOutput = '';

            osascript.stdout.on('data', (data: Buffer) => {
                output += data.toString().trim();
            });

            osascript.stderr.on('data', (data: Buffer) => {
                errorOutput += data.toString();
            });

            osascript.on('close', (code: number | null) => {
                if (code === 0 && (output === 'success' || output === 'fallback')) {
                    this.logger.debug(`Command sent via macOS automation (${output})`);
                    resolve(true);
                } else {
                    this.logger.warn('AppleScript failed:', { code, output, error: errorOutput });
                    reject(new Error(`macOS automation failed: ${errorOutput || output}`));
                }
            });

            osascript.on('error', (err: Error) => {
                reject(err);
            });
        });
    }

    async _sendCommandViaNotification(command: string): Promise<boolean> {
        // As fallback option, send desktop notification to remind user
        return new Promise((resolve) => {
            try {
                const commandPreview = command.length > 50 ? command.substring(0, 50) + '...' : command;

                if (process.platform === 'darwin') {
                    // macOS notification with more information
                    const script = `
                        display notification "Command: ${commandPreview.replace(/"/g, '\\"')}" with title "TaskPing - Email Command" subtitle "Click Terminal or Claude Code window, then paste command" sound name "default"
                    `;
                    const notification = spawn('osascript', ['-e', script]);

                    notification.on('close', () => {
                        this.logger.info('macOS notification sent to user');
                        resolve(true);
                    });

                    notification.on('error', () => {
                        resolve(false);
                    });
                } else {
                    // Linux notification
                    const notification = spawn('notify-send', [
                        'TaskPing - Email Command',
                        `Command: ${commandPreview}`
                    ]);

                    notification.on('close', () => {
                        this.logger.info('Linux notification sent to user');
                        resolve(true);
                    });

                    notification.on('error', () => {
                        resolve(false);
                    });
                }

            } catch (error: unknown) {
                this.logger.warn('Failed to send notification:', (error as Error).message);
                resolve(false);
            }
        });
    }

    _handleCommandError(commandItem: QueueItem, error: Error): void {
        commandItem.retries = (commandItem.retries || 0) + 1;

        if (commandItem.retries < commandItem.maxRetries) {
            // Retry
            commandItem.status = 'queued';
            commandItem.retryAt = new Date(Date.now() + (commandItem.retries * 60000)).toISOString(); // Delayed retry
            this.logger.info(`Command ${commandItem.id} will be retried (attempt ${commandItem.retries + 1})`);
        } else {
            // Reached maximum retry count
            commandItem.status = 'failed';
            this.logger.error(`Command ${commandItem.id} failed after ${commandItem.retries} retries`);
        }

        this._saveState();
    }

    _generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    getStatus(): RelayStatus {
        return {
            isRunning: this.isRunning,
            queueLength: this.commandQueue.length,
            processing: this.processingQueue,
            emailListener: this.emailListener ? {
                connected: this.emailListener.isConnected,
                listening: this.emailListener.isListening
            } : null,
            recentCommands: this.commandQueue.slice(-5).map(cmd => ({
                id: cmd.id,
                status: cmd.status,
                queuedAt: cmd.queuedAt,
                command: cmd.command.substring(0, 50) + '...'
            }))
        };
    }

    // Manually cleanup completed commands
    cleanupCompletedCommands(): void {
        const beforeCount = this.commandQueue.length;
        this.commandQueue = this.commandQueue.filter(cmd =>
            cmd.status !== 'completed' ||
            new Date(cmd.completedAt!) > new Date(Date.now() - 24 * 60 * 60 * 1000) // Keep records within 24 hours
        );

        const removedCount = beforeCount - this.commandQueue.length;
        if (removedCount > 0) {
            this.logger.info(`Cleaned up ${removedCount} completed commands`);
            this._saveState();
        }
    }
}

export = CommandRelayService;
