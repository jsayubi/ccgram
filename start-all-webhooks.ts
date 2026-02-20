#!/usr/bin/env node

/**
 * Multi-Platform Webhook Server
 * Starts all enabled webhook servers (Telegram, LINE) in parallel
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { PROJECT_ROOT } from './src/utils/paths';

// Load environment variables
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

console.log('\u{1F680} Starting Claude Code Remote Multi-Platform Webhook Server...\n');

interface ProcessEntry {
    name: string;
    process: ChildProcess;
}

const processes: ProcessEntry[] = [];

// Start Telegram webhook if enabled
if (process.env.TELEGRAM_ENABLED === 'true' && process.env.TELEGRAM_BOT_TOKEN) {
    console.log('\u{1F4F1} Starting Telegram webhook server...');
    const telegramProcess = spawn('node', [path.join(__dirname, 'start-telegram-webhook.js')], {
        stdio: ['inherit', 'inherit', 'inherit'],
        env: process.env
    });

    telegramProcess.on('exit', (code) => {
        console.log(`\u{1F4F1} Telegram webhook server exited with code ${code}`);
    });

    processes.push({ name: 'Telegram', process: telegramProcess });
}

// Start LINE webhook if enabled
if (process.env.LINE_ENABLED === 'true' && process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    console.log('\u{1F4F1} Starting LINE webhook server...');
    const lineProcess = spawn('node', [path.join(__dirname, 'start-line-webhook.js')], {
        stdio: ['inherit', 'inherit', 'inherit'],
        env: process.env
    });

    lineProcess.on('exit', (code) => {
        console.log(`\u{1F4F1} LINE webhook server exited with code ${code}`);
    });

    processes.push({ name: 'LINE', process: lineProcess });
}

// Start Email daemon if enabled
if (process.env.EMAIL_ENABLED === 'true' && process.env.SMTP_USER) {
    console.log('\u{1F4E7} Starting email daemon...');
    const emailProcess = spawn('node', [path.join(__dirname, 'claude-remote.js'), 'daemon', 'start'], {
        stdio: ['inherit', 'inherit', 'inherit'],
        env: process.env
    });

    emailProcess.on('exit', (code) => {
        console.log(`\u{1F4E7} Email daemon exited with code ${code}`);
    });

    processes.push({ name: 'Email', process: emailProcess });
}

if (processes.length === 0) {
    console.log('\u274C No platforms enabled. Please configure at least one platform in .env file:');
    console.log('   - Set TELEGRAM_ENABLED=true and configure TELEGRAM_BOT_TOKEN');
    console.log('   - Set LINE_ENABLED=true and configure LINE_CHANNEL_ACCESS_TOKEN');
    console.log('   - Set EMAIL_ENABLED=true and configure SMTP_USER');
    console.log('\n   Tip: run `npm run setup` for an interactive configuration wizard.');
    process.exit(1);
}

console.log(`\n\u2705 Started ${processes.length} webhook server(s):`);
processes.forEach(p => {
    console.log(`   - ${p.name}`);
});

console.log('\n\u{1F4CB} Platform Command Formats:');
if (process.env.TELEGRAM_ENABLED === 'true') {
    console.log('   Telegram: /cmd TOKEN123 <command>');
}
if (process.env.LINE_ENABLED === 'true') {
    console.log('   LINE: Token TOKEN123 <command>');
}
if (process.env.EMAIL_ENABLED === 'true') {
    console.log('   Email: Reply to notification emails');
}

console.log('\n\u{1F527} To stop all services, press Ctrl+C\n');

// Handle graceful shutdown
function shutdown(): void {
    console.log('\n\u{1F6D1} Shutting down all webhook servers...');

    processes.forEach(p => {
        console.log(`   Stopping ${p.name}...`);
        p.process.kill('SIGTERM');
    });

    setTimeout(() => {
        console.log('\u2705 All services stopped');
        process.exit(0);
    }, 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Keep the main process alive
process.stdin.resume();
