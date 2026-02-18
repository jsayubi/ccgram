#!/usr/bin/env node

/**
 * CCGram interactive setup
 * - Guides user through Telegram bot configuration
 * - Installs to ~/.ccgram/ for persistent hook paths
 * - Merges required hooks into ~/.claude/settings.json
 * - Generates launchd/systemd service file
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import https from 'https';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import { PROJECT_ROOT, CCGRAM_HOME } from './src/utils/paths';

interface HookDefinition {
    event: string;
    script: string;
    timeout: number;
    args?: string;
    matcher?: string;
}

interface SelectOption {
    label: string;
    value: string;
}

interface HookEntry {
    matcher?: string;
    hooks: { type: string; command: string; timeout: number }[];
}

interface EnsureHooksResult {
    settingsPath: string;
    existing: boolean;
    backupPath: string | null;
}

let projectRoot: string = PROJECT_ROOT;
let envPath: string = path.join(projectRoot, '.env');
let defaultSessionMap: string = path.join(PROJECT_ROOT, 'src', 'data', 'session-map.json');

// Hook definitions for Claude Code integration
const HOOK_DEFINITIONS: HookDefinition[] = [
    { event: 'PermissionRequest', script: 'permission-hook.js', timeout: 120 },
    { event: 'PreToolUse', script: 'question-notify.js', timeout: 5, matcher: 'AskUserQuestion' },
    { event: 'Stop', script: 'enhanced-hook-notify.js', args: 'completed', timeout: 5 },
    { event: 'Notification', script: 'enhanced-hook-notify.js', args: 'waiting', timeout: 5, matcher: 'permission_prompt' },
];

// ANSI color codes
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    underscore: '\x1b[4m',
    blink: '\x1b[5m',
    reverse: '\x1b[7m',
    hidden: '\x1b[8m',

    // Foreground colors
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',

    // Background colors
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
    bgWhite: '\x1b[47m'
} as const;

// Icons
const icons = {
    check: '\u2713',
    cross: '\u2717',
    info: '\u2139',
    warning: '\u26A0',
    arrow: '\u2192',
    bullet: '\u2022',
} as const;

type ColorName = keyof typeof colors;

// Helper functions for colored output
const color = (text: string, colorName: ColorName): string => `${colors[colorName]}${text}${colors.reset}`;
const bold = (text: string): string => `${colors.bright}${text}${colors.reset}`;
const dim = (text: string): string => `${colors.dim}${text}${colors.reset}`;
const success = (text: string): string => color(`${icons.check} ${text}`, 'green');
const error = (text: string): string => color(`${icons.cross} ${text}`, 'red');
const warning = (text: string): string => color(`${icons.warning} ${text}`, 'yellow');
const info = (text: string): string => color(`${icons.info} ${text}`, 'blue');

const rl: readline.Interface = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// ─── Box-drawing helpers ──────────────────────────────────────

function centerText(text: string, visibleLen: number, width: number): string {
    const pad = Math.max(0, Math.floor((width - visibleLen) / 2));
    return ' '.repeat(pad) + text;
}

function printHeader(): void {
    const W = 54; // inner width (between the vertical bars)
    const top    = `  \u250C${ '\u2500'.repeat(W) }\u2510`;
    const bottom = `  \u2514${ '\u2500'.repeat(W) }\u2518`;
    const blank  = `  \u2502${ ' '.repeat(W) }\u2502`;

    const title    = bold(color('CCGram Setup', 'cyan'));
    const titleLen = 12; // "CCGram Setup"
    const sub      = dim('Control Claude Code from Telegram');
    const subLen   = 32; // "Control Claude Code from Telegram"

    console.log();
    console.log(top);
    console.log(blank);
    console.log(`  \u2502${centerText(title, titleLen, W)}`
        + ' '.repeat(Math.max(0, W - Math.floor((W - titleLen) / 2) - titleLen)) + '\u2502');
    console.log(`  \u2502${centerText(sub, subLen, W)}`
        + ' '.repeat(Math.max(0, W - Math.floor((W - subLen) / 2) - subLen)) + '\u2502');
    console.log(blank);
    console.log(bottom);
    console.log();
}

function printSection(title: string): void {
    const line = '\u2500'.repeat(42 - title.length);
    console.log('\n  ' + bold(color(`\u2500\u2500\u2500 ${title} `, 'cyan')) + color(line, 'gray'));
    console.log();
}

function ask(question: string, defaultValue: string = ''): Promise<string> {
    const suffix: string = defaultValue ? dim(` (${defaultValue})`) : '';
    return new Promise<string>(resolve => {
        rl.question(`  ${color(icons.arrow, 'green')} ${question}${suffix}: `, (answer: string) => {
            resolve(answer.trim() || defaultValue);
        });
    });
}

function askSelect(question: string, options: SelectOption[], defaultIndex: number = 0): Promise<SelectOption> {
    return new Promise<SelectOption>(resolve => {
        console.log(`\n${bold(question)}`);
        options.forEach((opt: SelectOption, idx: number) => {
            const num: string = dim(`[${idx + 1}]`);
            const isDefault: boolean = idx === defaultIndex;
            const label: string = isDefault ? bold(opt.label) : opt.label;
            console.log(`  ${num} ${label}`);
        });
        rl.question(`\n${color(icons.arrow, 'green')} Select (1-${options.length}) ${dim(`[${defaultIndex + 1}]`)}: `, (answer: string) => {
            const num: number = parseInt(answer.trim() || String(defaultIndex + 1));
            if (num >= 1 && num <= options.length) {
                resolve(options[num - 1]);
            } else {
                resolve(options[defaultIndex]);
            }
        });
    });
}

function askYesNo(question: string, defaultValue: boolean = false): Promise<boolean> {
    const suffix: string = defaultValue ? color(' [Y/n]', 'green') : color(' [y/N]', 'red');
    return new Promise<boolean>(resolve => {
        rl.question(`  ${color(icons.arrow, 'green')} ${question}${suffix} `, (answer: string) => {
            const normalized: string = answer.trim().toLowerCase();
            if (!normalized) return resolve(defaultValue);
            resolve(normalized === 'y' || normalized === 'yes');
        });
    });
}

function loadExistingEnv(): Record<string, string> {
    if (!fs.existsSync(envPath)) return {};
    try {
        const content: string = fs.readFileSync(envPath, 'utf8');
        return dotenv.parse(content);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(warning('Failed to parse existing .env, starting fresh:') + ' ' + message);
        return {};
    }
}

function checkTmux(): boolean {
    try {
        const version: string = execSync('tmux -V', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        console.log('  ' + success(`tmux found: ${version}`));
        return true;
    } catch {
        const isMac: boolean = process.platform === 'darwin';
        console.log('  ' + warning('tmux is not installed \u2014 required for keystroke injection'));
        console.log(dim(`     Install: ${isMac ? 'brew install tmux' : 'sudo apt install tmux'}`));
        return false;
    }
}

function validateBotToken(token: string): Promise<{ ok: boolean; username?: string }> {
    return new Promise<{ ok: boolean; username?: string }>(resolve => {
        const url: string = `https://api.telegram.org/bot${token}/getMe`;
        const req = https.get(url, { timeout: 10000 }, (res) => {
            let data: string = '';
            res.on('data', (chunk: Buffer | string) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data) as Record<string, unknown>;
                    if (json.ok && json.result) {
                        const result = json.result as Record<string, unknown>;
                        resolve({ ok: true, username: String(result.username) });
                    } else {
                        console.log('  ' + warning(`Bot token validation failed: ${(json.description as string) || 'unknown error'}`));
                        resolve({ ok: false });
                    }
                } catch {
                    console.log('  ' + warning('Bot token validation failed: invalid API response'));
                    resolve({ ok: false });
                }
            });
        });
        req.on('error', (err: Error) => {
            console.log('  ' + warning(`Bot token validation failed: ${err.message}`));
            resolve({ ok: false });
        });
        req.on('timeout', () => {
            req.destroy();
            console.log('  ' + warning('Bot token validation timed out'));
            resolve({ ok: false });
        });
    });
}

function serializeEnvValue(value: unknown): string {
    if (value === undefined || value === null) return '';
    const stringValue: string = String(value);
    if (stringValue === '') return '';
    if (/[^\w@%/:.\-]/.test(stringValue)) {
        return `"${stringValue.replace(/"/g, '\\"')}"`;
    }
    return stringValue;
}

function writeEnvFile(values: Record<string, string>, existingEnv: Record<string, string>): string {
    const orderedKeys: string[] = [
        'TELEGRAM_ENABLED', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_GROUP_ID',
        'TELEGRAM_WHITELIST', 'TELEGRAM_WEBHOOK_URL', 'TELEGRAM_WEBHOOK_PORT',
        'TELEGRAM_FORCE_IPV4',
        'PROJECT_DIRS',
        'SESSION_MAP_PATH', 'INJECTION_MODE', 'CLAUDE_CLI_PATH', 'LOG_LEVEL'
    ];

    // Merge: new values override existing, keep any extra keys user already had
    const merged: Record<string, string> = { ...existingEnv, ...values };
    const lines: string[] = [];

    lines.push('# CCGram configuration');
    lines.push(`# Generated by ccgram init on ${new Date().toISOString()}`);
    lines.push('');

    orderedKeys.forEach((key: string) => {
        if (merged[key] === undefined) return;
        lines.push(`${key}=${serializeEnvValue(merged[key])}`);
    });

    const extras: string[] = Object.keys(merged).filter(k => !orderedKeys.includes(k));
    if (extras.length > 0) {
        lines.push('');
        lines.push('# User-defined / preserved keys');
        extras.forEach((key: string) => {
            lines.push(`${key}=${serializeEnvValue(merged[key])}`);
        });
    }

    fs.writeFileSync(envPath, lines.join('\n') + '\n');
    return envPath;
}

function makeHookCommand(def: HookDefinition): string {
    const scriptPath: string = path.join(projectRoot, 'dist', def.script);
    const quoted: string = scriptPath.includes(' ') ? `"${scriptPath}"` : scriptPath;
    return def.args ? `node ${quoted} ${def.args}` : `node ${quoted}`;
}

function buildHooksJSON(): Record<string, HookEntry[]> {
    const hooks: Record<string, HookEntry[]> = {};
    for (const def of HOOK_DEFINITIONS) {
        const entry: HookEntry = {} as HookEntry;
        if (def.matcher) entry.matcher = def.matcher;
        entry.hooks = [{ type: 'command', command: makeHookCommand(def), timeout: def.timeout }];

        if (!hooks[def.event]) hooks[def.event] = [];
        hooks[def.event].push(entry);
    }
    return hooks;
}

function ensureHooksFile(): EnsureHooksResult {
    const settingsDir: string = path.join(os.homedir(), '.claude');
    const settingsPath: string = path.join(settingsDir, 'settings.json');
    let settings: Record<string, unknown> = {};
    let existing: boolean = false;
    let backupPath: string | null = null;

    if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, { recursive: true });
    }

    if (fs.existsSync(settingsPath)) {
        existing = true;
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        } catch {
            backupPath = `${settingsPath}.bak-${Date.now()}`;
            fs.copyFileSync(settingsPath, backupPath);
            console.warn(warning(`Existing ~/.claude/settings.json is invalid JSON, backed up to ${backupPath}`));
            settings = {};
        }
    }

    if (!settings.hooks) settings.hooks = {};
    const hooksObj = settings.hooks as Record<string, HookEntry[]>;

    for (const def of HOOK_DEFINITIONS) {
        const command: string = makeHookCommand(def);
        const eventHooks: HookEntry[] = Array.isArray(hooksObj[def.event]) ? hooksObj[def.event] : [];

        const exists: boolean = eventHooks.some((entry: HookEntry) =>
            Array.isArray(entry.hooks) && entry.hooks.some(h => h.command === command)
        );
        if (!exists) {
            const entry: HookEntry = {} as HookEntry;
            if (def.matcher) entry.matcher = def.matcher;
            entry.hooks = [{ type: 'command', command, timeout: def.timeout }];
            eventHooks.push(entry);
        }
        hooksObj[def.event] = eventHooks;
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    return { settingsPath, existing, backupPath };
}

function printServiceInstructions(): void {
    const isMac: boolean = process.platform === 'darwin';
    const isLinux: boolean = process.platform === 'linux';

    printSection('Background Service');

    if (isLinux) {
        // Generate a filled-in systemd unit file
        const user: string = os.userInfo().username;
        const nodePath: string = process.execPath;
        const logsDir: string = path.join(projectRoot, 'logs');
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

        const unit: string = [
            '[Unit]',
            'Description=CCGram - Claude Code Telegram Bot',
            'After=network.target',
            '',
            '[Service]',
            'Type=simple',
            `User=${user}`,
            `WorkingDirectory=${projectRoot}`,
            `ExecStart=${nodePath} dist/workspace-telegram-bot.js`,
            'Restart=always',
            'RestartSec=5',
            'Environment=NODE_ENV=production',
            '',
            `StandardOutput=append:${logsDir}/bot-stdout.log`,
            `StandardError=append:${logsDir}/bot-stderr.log`,
            '',
            '[Install]',
            'WantedBy=multi-user.target',
        ].join('\n');

        const servicePath: string = path.join(projectRoot, 'ccgram.service');
        fs.writeFileSync(servicePath, unit + '\n');

        // Try to auto-install the systemd service
        try {
            execSync(`sudo cp ${servicePath} /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable ccgram && sudo systemctl start ccgram`, { stdio: 'pipe' });
            console.log('  ' + success('Bot service installed and started'));
        } catch {
            console.log('  ' + success(`Generated ${servicePath}`));
            console.log();
            console.log(dim('  Install as systemd service (requires sudo):'));
            console.log(dim(`    sudo cp ${servicePath} /etc/systemd/system/`));
            console.log(dim('    sudo systemctl daemon-reload'));
            console.log(dim('    sudo systemctl enable ccgram'));
            console.log(dim('    sudo systemctl start ccgram'));
        }
        console.log();
        console.log(dim('  Manage:'));
        console.log(dim('    sudo systemctl restart ccgram'));
        console.log(dim('    journalctl -u ccgram -f'));
    } else if (isMac) {
        // Generate a filled-in launchd plist
        const nodePath: string = process.execPath;
        const nodeDir: string = path.dirname(nodePath);
        const logsDir: string = path.join(projectRoot, 'logs');
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

        const plist: string = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
            '<plist version="1.0">',
            '<dict>',
            '    <key>Label</key>',
            '    <string>com.ccgram</string>',
            '',
            '    <key>ProgramArguments</key>',
            '    <array>',
            `        <string>${nodePath}</string>`,
            `        <string>${path.join(projectRoot, 'dist', 'workspace-telegram-bot.js')}</string>`,
            '    </array>',
            '',
            '    <key>WorkingDirectory</key>',
            `    <string>${projectRoot}</string>`,
            '',
            '    <key>EnvironmentVariables</key>',
            '    <dict>',
            '        <key>PATH</key>',
            `        <string>${nodeDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>`,
            '        <key>HOME</key>',
            `        <string>${os.homedir()}</string>`,
            '    </dict>',
            '',
            '    <key>RunAtLoad</key>',
            '    <true/>',
            '',
            '    <key>KeepAlive</key>',
            '    <true/>',
            '',
            '    <key>StandardOutPath</key>',
            `    <string>${logsDir}/bot-stdout.log</string>`,
            '',
            '    <key>StandardErrorPath</key>',
            `    <string>${logsDir}/bot-stderr.log</string>`,
            '',
            '    <key>ThrottleInterval</key>',
            '    <integer>10</integer>',
            '</dict>',
            '</plist>',
        ].join('\n');

        const plistDir: string = path.join(os.homedir(), 'Library', 'LaunchAgents');
        if (!fs.existsSync(plistDir)) fs.mkdirSync(plistDir, { recursive: true });
        const plistPath: string = path.join(plistDir, 'com.ccgram.plist');
        fs.writeFileSync(plistPath, plist + '\n');

        // Auto-load the service
        try {
            execSync('launchctl bootout gui/$(id -u)/com.ccgram 2>/dev/null', { stdio: 'pipe' });
        } catch {}
        try {
            execSync(`launchctl bootstrap gui/$(id -u) ${plistPath}`, { stdio: 'pipe' });
            console.log('  ' + success('Bot service started'));
        } catch {
            console.log('  ' + warning('Could not auto-start service. Load manually:'));
            console.log(dim(`    launchctl bootstrap gui/$(id -u) ${plistPath}`));
        }
        console.log();
        console.log(dim('  Manage:'));
        console.log(dim('    launchctl kickstart -k gui/$(id -u)/com.ccgram   # restart'));
        console.log(dim(`    tail -f ${logsDir}/bot-stdout.log                # logs`));
    } else {
        console.log(dim('  Run the bot with: npm start'));
        console.log(dim('  Or use a process manager like pm2:'));
        console.log(dim('    npx pm2 start workspace-telegram-bot.js --name ccgram'));
    }
}

function installToHome(sourceRoot: string): string {
    if (path.resolve(sourceRoot) === path.resolve(CCGRAM_HOME)) {
        console.log(dim('  Already running from ~/.ccgram, skipping install copy'));
        return CCGRAM_HOME;
    }

    console.log(info(`Installing to ${CCGRAM_HOME}...`));

    // Create directory structure
    for (const sub of ['dist', 'src/data', 'logs', 'config']) {
        fs.mkdirSync(path.join(CCGRAM_HOME, sub), { recursive: true });
    }

    // Preserve existing .env
    let preservedEnv: string | null = null;
    const homeEnvPath = path.join(CCGRAM_HOME, '.env');
    if (fs.existsSync(homeEnvPath)) {
        preservedEnv = fs.readFileSync(homeEnvPath, 'utf8');
    }

    // Copy required files
    const filesToCopy: Array<{ src: string; dest: string; dir?: boolean }> = [
        { src: 'package.json', dest: 'package.json' },
        { src: 'dist', dest: 'dist', dir: true },
        { src: 'config', dest: 'config', dir: true },
        { src: '.env.example', dest: '.env.example' },
    ];

    for (const item of filesToCopy) {
        const srcPath = path.join(sourceRoot, item.src);
        const destPath = path.join(CCGRAM_HOME, item.dest);
        if (!fs.existsSync(srcPath)) continue;
        if (item.dir) {
            fs.cpSync(srcPath, destPath, { recursive: true, force: true });
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }

    // Copy dotenv module (only required runtime dependency)
    const dotenvSrc = path.join(sourceRoot, 'node_modules', 'dotenv');
    const dotenvDest = path.join(CCGRAM_HOME, 'node_modules', 'dotenv');
    if (fs.existsSync(dotenvSrc)) {
        fs.mkdirSync(path.join(CCGRAM_HOME, 'node_modules'), { recursive: true });
        fs.cpSync(dotenvSrc, dotenvDest, { recursive: true, force: true });
    } else if (!fs.existsSync(path.join(dotenvDest, 'package.json'))) {
        // dotenv wasn't in source and isn't already installed — npm install it
        console.log(dim('  Installing dotenv dependency...'));
        try {
            execSync('npm install --production --no-optional', { cwd: CCGRAM_HOME, stdio: 'pipe' });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.log(warning(`Failed to install dependencies: ${message}`));
        }
    }

    // Restore existing ~/.ccgram/.env, or migrate source .env on first install
    if (preservedEnv !== null) {
        fs.writeFileSync(homeEnvPath, preservedEnv);
    } else {
        const sourceEnvPath = path.join(sourceRoot, '.env');
        if (fs.existsSync(sourceEnvPath)) {
            fs.copyFileSync(sourceEnvPath, homeEnvPath);
        }
    }

    // Verify key files
    const requiredFiles = [
        'dist/permission-hook.js',
        'dist/workspace-telegram-bot.js',
        'node_modules/dotenv/package.json',
    ];
    const missing = requiredFiles.filter(f => !fs.existsSync(path.join(CCGRAM_HOME, f)));
    if (missing.length > 0) {
        console.log(warning(`Missing files in ~/.ccgram/: ${missing.join(', ')}`));
    } else {
        console.log('  ' + success(`Installed to ${CCGRAM_HOME}`));
    }

    return CCGRAM_HOME;
}

// ─── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
    printHeader();

    // Install to ~/.ccgram/ for persistent hook paths
    projectRoot = installToHome(PROJECT_ROOT);
    envPath = path.join(projectRoot, '.env');
    defaultSessionMap = path.join(projectRoot, 'src', 'data', 'session-map.json');

    // Check tmux availability + show paths
    checkTmux();
    console.log(dim(`  Install path: ${projectRoot}`));
    console.log(dim(`  Config: ${envPath}`));

    const existingEnv: Record<string, string> = loadExistingEnv();

    // ─── Telegram ──────────────────────────────────────────
    printSection('Telegram');
    console.log(dim('  Create a bot with @BotFather and get your chat ID from @userinfobot'));
    console.log();

    const botToken: string = await ask('Bot token (from @BotFather)', existingEnv.TELEGRAM_BOT_TOKEN || '');
    const chatId: string = await ask('Chat ID (from @userinfobot)', existingEnv.TELEGRAM_CHAT_ID || '');

    const defaultProjectDirs = existingEnv.PROJECT_DIRS || `${os.homedir()}/projects,${os.homedir()}/tools`;
    const projectDirs: string = await ask('Project directories, comma-separated', defaultProjectDirs);

    // ─── Advanced settings (single gate) ───────────────────
    let groupId = existingEnv.TELEGRAM_GROUP_ID || '';
    let whitelist = existingEnv.TELEGRAM_WHITELIST || '';
    let webhookUrl = existingEnv.TELEGRAM_WEBHOOK_URL || '';
    let webhookPort = existingEnv.TELEGRAM_WEBHOOK_PORT || '3001';
    let forceIPv4 = existingEnv.TELEGRAM_FORCE_IPV4 === 'true';
    let injectionMode = existingEnv.INJECTION_MODE || 'tmux';
    let logLevel = existingEnv.LOG_LEVEL || 'info';
    let sessionMapPath = existingEnv.SESSION_MAP_PATH || defaultSessionMap;
    let advancedConfigured = false;

    console.log();
    const showAdvanced: boolean = await askYesNo('Configure advanced settings?', false);
    if (showAdvanced) {
        advancedConfigured = true;
        printSection('Advanced');
        groupId = await ask('Group chat ID (optional)', groupId);
        whitelist = await ask('Allowed user IDs, comma-separated (optional)', whitelist);
        webhookUrl = await ask('Webhook URL (leave empty for long-polling)', webhookUrl);
        if (webhookUrl) {
            webhookPort = await ask('Webhook port', webhookPort);
        }
        forceIPv4 = await askYesNo('Force IPv4 for Telegram API?', forceIPv4);
        injectionMode = (await ask('Injection mode (tmux or pty)', injectionMode)).toLowerCase();
        if (!['tmux', 'pty'].includes(injectionMode)) {
            console.log('  ' + warning('Invalid injection mode, defaulting to tmux'));
            injectionMode = 'tmux';
        }
        logLevel = await ask('Log level (debug, info, warn, error)', logLevel);
        sessionMapPath = await ask('Session map path', sessionMapPath);
    }

    // ─── Build env values ──────────────────────────────────
    const envValues: Record<string, string> = {
        TELEGRAM_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: botToken,
        TELEGRAM_CHAT_ID: chatId,
        PROJECT_DIRS: projectDirs,
    };

    // Only write advanced keys if user configured them or they existed before
    if (groupId) envValues.TELEGRAM_GROUP_ID = groupId;
    if (whitelist) envValues.TELEGRAM_WHITELIST = whitelist;
    if (webhookUrl) envValues.TELEGRAM_WEBHOOK_URL = webhookUrl;
    if (webhookUrl && webhookPort) envValues.TELEGRAM_WEBHOOK_PORT = webhookPort;
    if (forceIPv4) envValues.TELEGRAM_FORCE_IPV4 = 'true';
    if (advancedConfigured || existingEnv.INJECTION_MODE) envValues.INJECTION_MODE = injectionMode;
    if (advancedConfigured || existingEnv.SESSION_MAP_PATH) envValues.SESSION_MAP_PATH = sessionMapPath;
    if (logLevel !== 'info' || existingEnv.LOG_LEVEL) envValues.LOG_LEVEL = logLevel;

    // ─── Write .env ────────────────────────────────────────
    const savedEnvPath: string = writeEnvFile(envValues, existingEnv);

    // ─── Validate bot token ────────────────────────────────
    let botUsername: string | undefined;
    if (botToken) {
        const result = await validateBotToken(botToken);
        botUsername = result.username;
    }

    // ─── Install hooks (automatic, no prompt) ──────────────
    const { settingsPath, existing, backupPath }: EnsureHooksResult = ensureHooksFile();
    if (backupPath) {
        console.log('  ' + warning(`Invalid settings.json backed up to ${backupPath}`));
    }

    // ─── Generate service file ─────────────────────────────
    printServiceInstructions();

    // ─── Print hooks JSON ──────────────────────────────────
    const hooksJSON: Record<string, HookEntry[]> = buildHooksJSON();
    console.log('\n  ' + bold('Hooks for ~/.claude/settings.json:'));
    console.log(color('  ' + '\u2500'.repeat(55), 'gray'));
    const jsonLines = JSON.stringify({ hooks: hooksJSON }, null, 2).split('\n');
    for (const line of jsonLines) {
        console.log(dim('  ' + line));
    }
    console.log(color('  ' + '\u2500'.repeat(55), 'gray'));

    // Close readline before summary output
    rl.close();

    // ─── Summary ───────────────────────────────────────────
    printSection('Complete');
    console.log('  ' + success(`Installed to ${projectRoot}`));
    console.log('  ' + success(`Saved ${savedEnvPath}`));
    if (botUsername) {
        console.log('  ' + success(`Bot verified: @${botUsername}`));
    }
    console.log('  ' + success(`Hooks ${existing ? 'updated' : 'created'}: ${settingsPath}`));
    console.log('  ' + success('Service generated'));
    console.log();
    console.log('  ' + bold('Next steps:'));
    console.log('    1. Open Telegram and message your bot');
    console.log('    2. Start Claude Code in a tmux session');
    console.log();
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(error(`Setup failed: ${message}`));
    rl.close();
    process.exit(1);
});
