#!/usr/bin/env node

/**
 * CCGram Daemon Service
 * Background daemon process for monitoring emails and processing remote commands
 */

import fs from 'fs';
import path from 'path';
import { spawn, exec, execSync } from 'child_process';
import Logger from '../core/logger';
import ConfigManager from '../core/config';

interface DaemonStatus {
    running: boolean;
    pid: number | null;
    pidFile: string;
    logFile: string;
    uptime: string | null;
}

class ClaudeCodeRemoteDaemon {
    logger: Logger;
    config: ConfigManager;
    pidFile: string;
    logFile: string;
    relayService: any;
    isRunning: boolean;

    constructor() {
        this.logger = new Logger('Daemon');
        this.config = new ConfigManager();
        this.pidFile = path.join(__dirname, '../data/ccgram-daemon.pid');
        this.logFile = path.join(__dirname, '../data/daemon.log');
        this.relayService = null;
        this.isRunning = false;

        // Ensure data directory exists
        const dataDir = path.dirname(this.pidFile);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
    }

    async start(detached: boolean = true): Promise<void> {
        try {
            // Check if already running
            if (this.isAlreadyRunning()) {
                console.log('❌ CCGram daemon is already running');
                console.log('💡 Use "claude-remote daemon stop" to stop existing service');
                process.exit(1);
            }

            if (detached) {
                // Start in daemon mode
                await this.startDetached();
            } else {
                // Run directly in current process
                await this.startForeground();
            }
        } catch (error: unknown) {
            this.logger.error('Failed to start daemon:', error);
            throw error;
        }
    }

    async startDetached(): Promise<void> {
        console.log('🚀 Starting CCGram daemon...');

        // Create child process
        const child = spawn(process.execPath, [__filename, '--foreground'], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        // Redirect logs
        const logStream = fs.createWriteStream(this.logFile, { flags: 'a' });
        child.stdout!.pipe(logStream);
        child.stderr!.pipe(logStream);

        // Save PID
        fs.writeFileSync(this.pidFile, child.pid!.toString());

        // Detach child process
        child.unref();

        console.log(`✅ CCGram daemon started (PID: ${child.pid})`);
        console.log(`📝 Log file: ${this.logFile}`);
        console.log('💡 Use "claude-remote daemon status" to view status');
        console.log('💡 Use "claude-remote daemon stop" to stop service');
    }

    async startForeground(): Promise<void> {
        console.log('🚀 CCGram daemon starting...');

        this.isRunning = true;
        process.title = 'ccgram-daemon';

        // Load configuration
        this.config.load();

        // Initialize email relay service
        const emailConfig = this.config.getChannel('email');
        if (!emailConfig || !emailConfig.enabled) {
            this.logger.warn('Email channel not configured or disabled');
            return;
        }

        const CommandRelayService = require('../relay/command-relay') as any;
        this.relayService = new CommandRelayService(emailConfig.config);

        // Setup event handlers
        this.setupEventHandlers();

        // Start service
        await this.relayService.start();
        this.logger.info('Email relay service started');

        // Keep process running
        this.keepAlive();
    }

    setupEventHandlers(): void {
        // Graceful shutdown
        const gracefulShutdown = async (signal: string): Promise<void> => {
            this.logger.info(`Received ${signal}, shutting down gracefully...`);
            this.isRunning = false;

            if (this.relayService) {
                await this.relayService.stop();
            }

            // Delete PID file
            if (fs.existsSync(this.pidFile)) {
                fs.unlinkSync(this.pidFile);
            }

            process.exit(0);
        };

        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGHUP', () => {
            this.logger.info('Received SIGHUP, reloading configuration...');
            this.config.load();
        });

        // Relay service events
        if (this.relayService) {
            this.relayService.on('started', () => {
                this.logger.info('Command relay service started');
            });

            this.relayService.on('commandQueued', (command: any) => {
                this.logger.info(`Command queued: ${command.id}`);
            });

            this.relayService.on('commandExecuted', (command: any) => {
                this.logger.info(`Command executed: ${command.id}`);
            });

            this.relayService.on('commandFailed', (command: any, error: Error) => {
                this.logger.error(`Command failed: ${command.id} - ${error.message}`);
            });
        }

        // Uncaught exception handling
        process.on('uncaughtException', (error: Error) => {
            this.logger.error('Uncaught exception:', error);
            process.exit(1);
        });

        process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
            this.logger.error('Unhandled rejection at:', promise, 'reason:', reason);
            process.exit(1);
        });
    }

    keepAlive(): void {
        // Keep process running
        const heartbeat = setInterval(() => {
            if (!this.isRunning) {
                clearInterval(heartbeat);
                return;
            }
            this.logger.debug('Heartbeat');
        }, 60000); // Output heartbeat log every minute
    }

    async stop(): Promise<void> {
        if (!this.isAlreadyRunning()) {
            console.log('❌ CCGram daemon is not running');
            return;
        }

        try {
            const pid = this.getPid();
            console.log(`🛑 Stopping CCGram daemon (PID: ${pid})...`);

            // Send SIGTERM signal
            process.kill(pid!, 'SIGTERM');

            // Wait for process to end
            await this.waitForStop(pid!);

            console.log('✅ CCGram daemon stopped');
        } catch (error: unknown) {
            console.error('❌ Failed to stop daemon:', (error as Error).message);

            // Force delete PID file
            if (fs.existsSync(this.pidFile)) {
                fs.unlinkSync(this.pidFile);
                console.log('🧹 PID file cleaned up');
            }
        }
    }

    async restart(): Promise<void> {
        console.log('🔄 Restarting CCGram daemon...');
        await this.stop();
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
        await this.start();
    }

    getStatus(): DaemonStatus {
        const isRunning = this.isAlreadyRunning();
        const pid = isRunning ? this.getPid() : null;

        return {
            running: isRunning,
            pid: pid,
            pidFile: this.pidFile,
            logFile: this.logFile,
            uptime: isRunning ? this.getUptime(pid!) : null
        };
    }

    showStatus(): void {
        const status = this.getStatus();

        console.log('📊 CCGram daemon status\n');

        if (status.running) {
            console.log('✅ Status: Running');
            console.log(`🆔 PID: ${status.pid}`);
            console.log(`⏱️ Uptime: ${status.uptime || 'Unknown'}`);
        } else {
            console.log('❌ Status: Not running');
        }

        console.log(`📝 Log file: ${status.logFile}`);
        console.log(`📁 PID file: ${status.pidFile}`);

        // Show recent logs
        if (fs.existsSync(status.logFile)) {
            console.log('\n📋 Recent logs:');
            try {
                const logs = fs.readFileSync(status.logFile, 'utf8');
                const lines = logs.split('\n').filter((line: string) => line.trim()).slice(-5);
                lines.forEach((line: string) => console.log(`  ${line}`));
            } catch (error: unknown) {
                console.log('  Unable to read log file');
            }
        }
    }

    isAlreadyRunning(): boolean {
        if (!fs.existsSync(this.pidFile)) {
            return false;
        }

        try {
            const pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'));
            // Check if process is still running
            process.kill(pid, 0);
            return true;
        } catch (error: unknown) {
            // Process doesn't exist, delete outdated PID file
            fs.unlinkSync(this.pidFile);
            return false;
        }
    }

    getPid(): number | null {
        if (!fs.existsSync(this.pidFile)) {
            return null;
        }
        return parseInt(fs.readFileSync(this.pidFile, 'utf8'));
    }

    async waitForStop(pid: number, timeout: number = 10000): Promise<void> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            try {
                process.kill(pid, 0);
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error: unknown) {
                // Process has stopped
                return;
            }
        }

        // Timeout, force termination
        throw new Error('Process stop timeout, may need manual termination');
    }

    getUptime(pid: number): string {
        try {
            // Get process start time on macOS and Linux
            const result = execSync(`ps -o lstart= -p ${pid}`, { encoding: 'utf8' });
            const startTime = new Date(result.trim());
            const uptime = Date.now() - startTime.getTime();

            const hours = Math.floor(uptime / (1000 * 60 * 60));
            const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));

            return `${hours}h ${minutes}m`;
        } catch (error: unknown) {
            return 'Unknown';
        }
    }
}

// Command line interface
if (require.main === module) {
    const daemon = new ClaudeCodeRemoteDaemon();
    const command = process.argv[2];

    (async () => {
        try {
            switch (command) {
                case 'start':
                    await daemon.start(true);
                    break;
                case '--foreground':
                    await daemon.start(false);
                    break;
                case 'stop':
                    await daemon.stop();
                    break;
                case 'restart':
                    await daemon.restart();
                    break;
                case 'status':
                    daemon.showStatus();
                    break;
                default:
                    console.log('Usage: ccgram-daemon <start|stop|restart|status>');
                    process.exit(1);
            }
        } catch (error: unknown) {
            console.error('Error:', (error as Error).message);
            process.exit(1);
        }
    })();
}

export = ClaudeCodeRemoteDaemon;
