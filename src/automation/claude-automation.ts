/**
 * Claude Code Dedicated Automation
 * Complete automation solution specifically designed for Claude Code
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import Logger from '../core/logger';

interface AutomationStatus {
    platform: NodeJS.Platform;
    supported: boolean;
    name: string;
}

class ClaudeAutomation {
    logger: Logger;

    constructor() {
        this.logger = new Logger('ClaudeAutomation');
    }

    /**
     * Fully automated command sending to Claude Code
     */
    async sendCommand(command: string, sessionId: string = ''): Promise<boolean> {
        try {
            this.logger.info(`Sending command to Claude Code: ${command.substring(0, 50)}...`);

            // First copy command to clipboard
            await this._copyToClipboard(command);

            // Then execute fully automated paste and execution
            const success = await this._fullAutomation(command);

            if (success) {
                this.logger.info('Command sent and executed successfully');
                return true;
            } else {
                // If failed, try fallback option
                return await this._fallbackAutomation(command);
            }

        } catch (error: unknown) {
            this.logger.error('Claude automation failed:', (error as Error).message);
            return false;
        }
    }

    /**
     * Copy command to clipboard
     */
    async _copyToClipboard(command: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const pbcopy = spawn('pbcopy');
            pbcopy.stdin.write(command);
            pbcopy.stdin.end();

            pbcopy.on('close', (code: number | null) => {
                if (code === 0) {
                    this.logger.debug('Command copied to clipboard');
                    resolve();
                } else {
                    reject(new Error('Failed to copy to clipboard'));
                }
            });

            pbcopy.on('error', reject);
        });
    }

    /**
     * Full automation solution
     */
    async _fullAutomation(command: string): Promise<boolean> {
        if (process.platform !== 'darwin') {
            return false;
        }

        return new Promise((resolve) => {
            const script = `
                tell application "System Events"
                    -- Define possible Claude Code application names
                    set claudeApps to {"Claude", "Claude Code", "Claude Desktop", "Anthropic Claude"}
                    set terminalApps to {"Terminal", "iTerm2", "iTerm", "Warp Terminal", "Warp"}
                    set codeApps to {"Visual Studio Code", "Code", "Cursor", "Sublime Text", "Atom"}

                    -- First try to find Claude Code
                    set targetApp to null
                    set appName to ""

                    -- Check Claude applications
                    repeat with app in claudeApps
                        try
                            if application process app exists then
                                set targetApp to application process app
                                set appName to app
                                exit repeat
                            end if
                        end try
                    end repeat

                    -- If Claude not found, check terminal applications
                    if targetApp is null then
                        repeat with app in terminalApps
                            try
                                if application process app exists then
                                    set targetApp to application process app
                                    set appName to app
                                    exit repeat
                                end if
                            end try
                        end repeat
                    end if

                    -- If still not found, check code editors
                    if targetApp is null then
                        repeat with app in codeApps
                            try
                                if application process app exists then
                                    set targetApp to application process app
                                    set appName to app
                                    exit repeat
                                end if
                            end try
                        end repeat
                    end if

                    if targetApp is not null then
                        -- Activate application
                        set frontmost of targetApp to true
                        delay 0.8

                        -- Wait for application to fully activate
                        repeat while (frontmost of targetApp) is false
                            delay 0.1
                        end repeat

                        -- Execute different operations based on application type
                        if appName contains "Claude" then
                            -- Claude Code specific operations
                            try
                                -- Try to click input box
                                click (first text field of window 1)
                                delay 0.3
                            on error
                                -- If no text box, try keyboard navigation
                                key code 125 -- Down arrow
                                delay 0.2
                            end try

                            -- Clear current content and paste new command
                            keystroke "a" using command down
                            delay 0.2
                            keystroke "v" using command down
                            delay 0.5

                            -- Execute command
                            keystroke return

                        else if appName contains "Terminal" or appName contains "iTerm" or appName contains "Warp" then
                            -- Terminal application operations
                            delay 0.5
                            keystroke "v" using command down
                            delay 0.3
                            keystroke return

                        else
                            -- Other applications (code editors, etc.)
                            delay 0.5
                            keystroke "v" using command down
                            delay 0.3
                            keystroke return
                        end if

                        return "success:" & appName
                    else
                        return "no_app_found"
                    end if
                end tell
            `;

            const osascript = spawn('osascript', ['-e', script]);
            let output = '';
            let error = '';

            osascript.stdout.on('data', (data: Buffer) => {
                output += data.toString().trim();
            });

            osascript.stderr.on('data', (data: Buffer) => {
                error += data.toString();
            });

            osascript.on('close', (code: number | null) => {
                if (code === 0 && output.startsWith('success:')) {
                    const appName = output.split(':')[1];
                    this.logger.info(`Command successfully sent to ${appName}`);
                    resolve(true);
                } else {
                    this.logger.warn(`Full automation failed: ${output || error}`);
                    resolve(false);
                }
            });

            osascript.on('error', (err: Error) => {
                this.logger.error('AppleScript execution error:', err.message);
                resolve(false);
            });
        });
    }

    /**
     * Fallback automation solution - more forceful method
     */
    async _fallbackAutomation(command: string): Promise<boolean> {
        if (process.platform !== 'darwin') {
            return false;
        }

        return new Promise((resolve) => {
            // More forceful approach, directly input text
            const escapedCommand = command
                .replace(/\\/g, '\\\\')
                .replace(/"/g, '\\"')
                .replace(/'/g, "\\'")
                .replace(/\n/g, '\\n');

            const script = `
                tell application "System Events"
                    -- Get current foreground application
                    set frontApp to first application process whose frontmost is true
                    set appName to name of frontApp

                    -- Wait a moment to ensure application responds
                    delay 1

                    -- Directly input command text (not dependent on clipboard)
                    try
                        -- First clear possible existing content
                        keystroke "a" using command down
                        delay 0.2

                        -- Input command
                        keystroke "${escapedCommand}"
                        delay 0.5

                        -- Execute
                        keystroke return

                        return "typed_success:" & appName
                    on error errorMsg
                        -- If direct input fails, try paste
                        try
                            keystroke "v" using command down
                            delay 0.3
                            keystroke return
                            return "paste_success:" & appName
                        on error
                            return "failed:" & errorMsg
                        end try
                    end try
                end tell
            `;

            const osascript = spawn('osascript', ['-e', script]);
            let output = '';

            osascript.stdout.on('data', (data: Buffer) => {
                output += data.toString().trim();
            });

            osascript.on('close', (code: number | null) => {
                if (code === 0 && (output.includes('success'))) {
                    this.logger.info(`Fallback automation succeeded: ${output}`);
                    resolve(true);
                } else {
                    this.logger.error(`Fallback automation failed: ${output}`);
                    resolve(false);
                }
            });

            osascript.on('error', () => {
                resolve(false);
            });
        });
    }

    /**
     * Specifically activate Claude Code application
     */
    async activateClaudeCode(): Promise<boolean> {
        if (process.platform !== 'darwin') {
            return false;
        }

        return new Promise((resolve) => {
            const script = `
                tell application "System Events"
                    set claudeApps to {"Claude", "Claude Code", "Claude Desktop", "Anthropic Claude"}

                    repeat with appName in claudeApps
                        try
                            if application process appName exists then
                                set frontmost of application process appName to true
                                return "activated:" & appName
                            end if
                        end try
                    end repeat

                    return "not_found"
                end tell
            `;

            const osascript = spawn('osascript', ['-e', script]);
            let output = '';

            osascript.stdout.on('data', (data: Buffer) => {
                output += data.toString().trim();
            });

            osascript.on('close', (code: number | null) => {
                if (code === 0 && output.startsWith('activated:')) {
                    this.logger.info('Claude Code activated successfully');
                    resolve(true);
                } else {
                    this.logger.warn('Could not activate Claude Code');
                    resolve(false);
                }
            });

            osascript.on('error', () => resolve(false));
        });
    }

    /**
     * Check system permissions and attempt to request
     */
    async requestPermissions(): Promise<boolean> {
        if (process.platform !== 'darwin') {
            return false;
        }

        try {
            // Try a simple operation to trigger permission request
            const script = `
                tell application "System Events"
                    try
                        set frontApp to name of first application process whose frontmost is true
                        return "permission_granted"
                    on error
                        return "permission_denied"
                    end try
                end tell
            `;

            const result = await this._runAppleScript(script);
            return result === 'permission_granted';
        } catch (error: unknown) {
            this.logger.error('Permission check failed:', (error as Error).message);
            return false;
        }
    }

    async _runAppleScript(script: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const osascript = spawn('osascript', ['-e', script]);
            let output = '';
            let error = '';

            osascript.stdout.on('data', (data: Buffer) => {
                output += data.toString();
            });

            osascript.stderr.on('data', (data: Buffer) => {
                error += data.toString();
            });

            osascript.on('close', (code: number | null) => {
                if (code === 0) {
                    resolve(output.trim());
                } else {
                    reject(new Error(error || `Exit code: ${code}`));
                }
            });
        });
    }

    /**
     * Get status information
     */
    getStatus(): AutomationStatus {
        return {
            platform: process.platform,
            supported: process.platform === 'darwin',
            name: 'Claude Code Automation'
        };
    }
}

export = ClaudeAutomation;
