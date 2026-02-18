#!/usr/bin/env node

/**
 * Interactive setup for Claude Code Remote
 * - Guides user through .env generation
 * - Merges required hooks into ~/.claude/settings.json
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

interface EmailPreset {
    smtpHost: string;
    smtpPort: string;
    smtpSecure: boolean;
    imapHost: string;
    imapPort: string;
    imapSecure: boolean;
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

interface I18nEmailConfig {
    title: string;
    quickSetup: string;
    provider: string;
    manual: string;
    gmail: string;
    outlook: string;
    qq: string;
    '163': string;
    email: string;
    appPassword: string;
    smtpHost: string;
    smtpPort: string;
    smtpSecure: string;
    smtpUser: string;
    smtpPass: string;
    emailFrom: string;
    emailFromName: string;
    emailTo: string;
    allowedSenders: string;
    reuseImap: string;
    imapHost: string;
    imapPort: string;
    imapSecure: string;
    imapUser: string;
    imapPass: string;
    checkInterval: string;
    setupInstructions: Record<string, string>;
}

interface I18nTelegramConfig {
    botToken: string;
    chatId: string;
    groupId: string;
    whitelist: string;
    webhookUrl: string;
    webhookPort: string;
    forceIPv4: string;
}

interface I18nLineConfig {
    channelAccessToken: string;
    channelSecret: string;
    userId: string;
    groupId: string;
    whitelist: string;
    webhookPort: string;
}

interface I18nStrings {
    welcome: string;
    projectRoot: string;
    targetEnv: string;
    selectLanguage: string;
    sessionMapPath: string;
    injectionMode: string;
    injectionModeInvalid: string;
    logLevel: string;
    enableEmail: string;
    enableTelegram: string;
    enableLine: string;
    emailConfig: I18nEmailConfig;
    telegramConfig: I18nTelegramConfig;
    lineConfig: I18nLineConfig;
    envSaved: string;
    updateHooks: string;
    hooksUpdated: string;
    hooksCreated: string;
    hooksSkipped: string;
    setupComplete: string;
    nextStep1: string;
    nextStep2: string;
    setupFailed: string;
    invalidSettings: string;
}

type I18nData = Record<string, I18nStrings>;

let projectRoot: string = PROJECT_ROOT;
let envPath: string = path.join(projectRoot, '.env');
// Hook definitions for Claude Code integration
const HOOK_DEFINITIONS: HookDefinition[] = [
    { event: 'PermissionRequest', script: 'permission-hook.js', timeout: 120 },
    { event: 'PreToolUse', script: 'question-notify.js', timeout: 5, matcher: 'AskUserQuestion' },
    { event: 'Stop', script: 'enhanced-hook-notify.js', args: 'completed', timeout: 5 },
    { event: 'Notification', script: 'enhanced-hook-notify.js', args: 'waiting', timeout: 5, matcher: 'permission_prompt' },
];
let defaultSessionMap: string = path.join(PROJECT_ROOT, 'src', 'data', 'session-map.json');
const i18nPath: string = path.join(PROJECT_ROOT, 'setup-i18n.json');

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
    star: '\u2605',
    robot: '\uD83E\uDD16',
    email: '\uD83D\uDCE7',
    telegram: '\uD83D\uDCAC',
    line: '\uD83D\uDC9A',
    globe: '\uD83C\uDF10',
    key: '\uD83D\uDD11',
    gear: '\u2699\uFE0F',
    rocket: '\uD83D\uDE80'
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

// Load i18n
const i18nData: I18nData = JSON.parse(fs.readFileSync(i18nPath, 'utf8'));
let lang: string = 'en';
let i18n: I18nStrings = i18nData[lang];

const rl: readline.Interface = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function printHeader(): void {
    console.clear();
    console.log(bold('\n' + '='.repeat(60)));
    console.log(bold(color(`${icons.robot} Claude Code Remote - Interactive Setup ${icons.gear}`, 'cyan')));
    console.log(bold('='.repeat(60)));
    console.log();
}

function printSection(title: string, icon: string = icons.bullet): void {
    console.log('\n' + bold(color(`${icon} ${title}`, 'cyan')));
    console.log(color('\u2500'.repeat(40), 'gray'));
}

function ask(question: string, defaultValue: string = ''): Promise<string> {
    const suffix: string = defaultValue ? dim(` (${defaultValue})`) : '';
    return new Promise<string>(resolve => {
        rl.question(`${color(icons.arrow, 'green')} ${question}${suffix}: `, (answer: string) => {
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
        rl.question(`${color(icons.arrow, 'green')} ${question}${suffix} `, (answer: string) => {
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
        console.log(success(`tmux found: ${version}`));
        return true;
    } catch {
        const isMac: boolean = process.platform === 'darwin';
        console.log(warning('tmux is not installed \u2014 required for keystroke injection'));
        console.log(dim(`   Install: ${isMac ? 'brew install tmux' : 'sudo apt install tmux'}`));
        return false;
    }
}

function validateBotToken(token: string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
        const url: string = `https://api.telegram.org/bot${token}/getMe`;
        const req = https.get(url, { timeout: 10000 }, (res) => {
            let data: string = '';
            res.on('data', (chunk: Buffer | string) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data) as Record<string, unknown>;
                    if (json.ok && json.result) {
                        const result = json.result as Record<string, unknown>;
                        console.log(success(`Bot verified: @${result.username}`));
                        resolve(true);
                    } else {
                        console.log(warning(`Bot token validation failed: ${(json.description as string) || 'unknown error'}`));
                        resolve(false);
                    }
                } catch {
                    console.log(warning('Bot token validation failed: invalid API response'));
                    resolve(false);
                }
            });
        });
        req.on('error', (err: Error) => {
            console.log(warning(`Bot token validation failed: ${err.message}`));
            resolve(false);
        });
        req.on('timeout', () => {
            req.destroy();
            console.log(warning('Bot token validation timed out'));
            resolve(false);
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
        'EMAIL_ENABLED', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS',
        'EMAIL_FROM', 'EMAIL_FROM_NAME', 'IMAP_HOST', 'IMAP_PORT', 'IMAP_SECURE',
        'IMAP_USER', 'IMAP_PASS', 'EMAIL_TO', 'ALLOWED_SENDERS', 'CHECK_INTERVAL',
        'LINE_ENABLED', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET',
        'LINE_USER_ID', 'LINE_GROUP_ID', 'LINE_WHITELIST', 'LINE_WEBHOOK_PORT',
        'TELEGRAM_ENABLED', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_GROUP_ID',
        'TELEGRAM_WHITELIST', 'TELEGRAM_WEBHOOK_URL', 'TELEGRAM_WEBHOOK_PORT',
        'TELEGRAM_FORCE_IPV4',
        'SESSION_MAP_PATH', 'INJECTION_MODE', 'CLAUDE_CLI_PATH', 'LOG_LEVEL'
    ];

    // Merge: new values override existing, keep any extra keys user already had
    const merged: Record<string, string> = { ...existingEnv, ...values };
    const lines: string[] = [];

    lines.push('# Claude Code Remote configuration');
    lines.push(`# Generated by setup.js on ${new Date().toISOString()}`);
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

    printSection('Background Service', icons.gear);

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
        console.log(success(`Generated ${servicePath}`));
        console.log();
        console.log(dim('  Install as systemd service:'));
        console.log(dim(`    sudo cp ${servicePath} /etc/systemd/system/`));
        console.log(dim('    sudo systemctl daemon-reload'));
        console.log(dim('    sudo systemctl enable ccgram'));
        console.log(dim('    sudo systemctl start ccgram'));
        console.log();
        console.log(dim('  Manage:'));
        console.log(dim('    sudo systemctl status ccgram'));
        console.log(dim('    sudo systemctl restart ccgram'));
        console.log(dim('    journalctl -u ccgram -f'));
    } else if (isMac) {
        console.log(dim('  The bot can run as a launchd service:'));
        console.log(dim(`    See CLAUDE.md for launchd plist setup`));
        console.log();
        console.log(dim('  Quick commands:'));
        console.log(dim('    launchctl kickstart -k gui/$(id -u)/com.ccgram'));
        console.log(dim('    tail -f logs/bot-stdout.log'));
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

    // setup-i18n.json is optional (only needed for re-running setup)
    if (fs.existsSync(path.join(sourceRoot, 'setup-i18n.json'))) {
        filesToCopy.push({ src: 'setup-i18n.json', dest: 'setup-i18n.json' });
    }

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
        console.log(success(`Installed to ${CCGRAM_HOME}`));
    }

    return CCGRAM_HOME;
}

async function main(): Promise<void> {
    printHeader();

    // Language selection first
    const langChoice: SelectOption = await askSelect(bold(`${icons.globe} ${i18nData.en.selectLanguage}`), [
        { label: 'English', value: 'en' },
        { label: 'Chinese', value: 'zh' }
    ], 0);
    lang = langChoice.value;
    i18n = i18nData[lang];

    // Install to ~/.ccgram/ for persistent hook paths
    printSection('Installation', icons.gear);
    projectRoot = installToHome(PROJECT_ROOT);
    envPath = path.join(projectRoot, '.env');
    defaultSessionMap = path.join(projectRoot, 'src', 'data', 'session-map.json');

    printHeader();
    console.log(dim(`${i18n.projectRoot}: ${projectRoot}`));
    console.log(dim(`${i18n.targetEnv}: ${envPath}`));

    // Check tmux availability
    checkTmux();

    const existingEnv: Record<string, string> = loadExistingEnv();

    // Basic Configuration
    printSection('Basic Configuration', icons.gear);

    const sessionMapPath: string = await ask(i18n.sessionMapPath, existingEnv.SESSION_MAP_PATH || defaultSessionMap);
    let injectionMode: string = (await ask(i18n.injectionMode, existingEnv.INJECTION_MODE || 'pty')).toLowerCase();
    if (!['tmux', 'pty'].includes(injectionMode)) {
        console.log(warning(i18n.injectionModeInvalid));
        injectionMode = 'pty';
    }
    const logLevel: string = await ask(i18n.logLevel, existingEnv.LOG_LEVEL || 'info');

    // Email Configuration
    const emailEnabled: boolean = await askYesNo(`${icons.email} ${i18n.enableEmail}`, existingEnv.EMAIL_ENABLED === 'true');
    const email: Record<string, any> = {};
    if (emailEnabled) {
        printSection(i18n.emailConfig.title, icons.email);

        // Email provider quick setup
        const providerChoice: SelectOption = await askSelect(i18n.emailConfig.quickSetup, [
            { label: i18n.emailConfig.gmail, value: 'gmail' },
            { label: i18n.emailConfig.outlook, value: 'outlook' },
            { label: i18n.emailConfig.qq, value: 'qq' },
            { label: i18n.emailConfig['163'], value: '163' },
            { label: dim(i18n.emailConfig.manual), value: 'manual' }
        ], 0);

        const emailPresets: Record<string, EmailPreset> = {
            gmail: {
                smtpHost: 'smtp.gmail.com',
                smtpPort: '465',
                smtpSecure: true,
                imapHost: 'imap.gmail.com',
                imapPort: '993',
                imapSecure: true
            },
            outlook: {
                smtpHost: 'smtp-mail.outlook.com',
                smtpPort: '587',
                smtpSecure: false,
                imapHost: 'outlook.office365.com',
                imapPort: '993',
                imapSecure: true
            },
            qq: {
                smtpHost: 'smtp.qq.com',
                smtpPort: '465',
                smtpSecure: true,
                imapHost: 'imap.qq.com',
                imapPort: '993',
                imapSecure: true
            },
            '163': {
                smtpHost: 'smtp.163.com',
                smtpPort: '465',
                smtpSecure: true,
                imapHost: 'imap.163.com',
                imapPort: '993',
                imapSecure: true
            }
        };

        if (providerChoice.value !== 'manual') {
            const preset: EmailPreset = emailPresets[providerChoice.value];
            console.log('\n' + info(i18n.emailConfig.setupInstructions[providerChoice.value]));

            email.emailAddress = await ask(i18n.emailConfig.email, existingEnv.SMTP_USER || '');
            email.appPassword = await ask(`${icons.key} ${i18n.emailConfig.appPassword}`, existingEnv.SMTP_PASS || '');

            email.smtpHost = preset.smtpHost;
            email.smtpPort = preset.smtpPort;
            email.smtpSecure = preset.smtpSecure;
            email.smtpUser = email.emailAddress;
            email.smtpPass = email.appPassword;
            email.emailFrom = email.emailAddress;
            email.emailFromName = existingEnv.EMAIL_FROM_NAME || 'Claude Code Remote';
            email.emailTo = email.emailAddress;
            email.allowedSenders = email.emailAddress;

            email.imapHost = preset.imapHost;
            email.imapPort = preset.imapPort;
            email.imapSecure = preset.imapSecure;
            email.imapUser = email.emailAddress;
            email.imapPass = email.appPassword;
        } else {
            // Manual configuration
            console.log(dim('\nManual email configuration...'));
            email.smtpHost = await ask(i18n.emailConfig.smtpHost, existingEnv.SMTP_HOST || 'smtp.gmail.com');
            email.smtpPort = await ask(i18n.emailConfig.smtpPort, existingEnv.SMTP_PORT || '465');
            email.smtpSecure = await askYesNo(i18n.emailConfig.smtpSecure, existingEnv.SMTP_SECURE === 'true' || existingEnv.SMTP_SECURE === undefined);
            email.smtpUser = await ask(i18n.emailConfig.smtpUser, existingEnv.SMTP_USER || '');
            email.smtpPass = await ask(i18n.emailConfig.smtpPass, existingEnv.SMTP_PASS || '');
            email.emailFrom = await ask(i18n.emailConfig.emailFrom, existingEnv.EMAIL_FROM || email.smtpUser);
            email.emailFromName = await ask(i18n.emailConfig.emailFromName, existingEnv.EMAIL_FROM_NAME || 'Claude Code Remote');
            email.emailTo = await ask(i18n.emailConfig.emailTo, existingEnv.EMAIL_TO || email.smtpUser);
            email.allowedSenders = await ask(i18n.emailConfig.allowedSenders, existingEnv.ALLOWED_SENDERS || email.emailTo);

            const reuseImap: boolean = await askYesNo(i18n.emailConfig.reuseImap, true);
            if (reuseImap) {
                email.imapHost = email.smtpHost.replace('smtp', 'imap');
                email.imapPort = '993';
                email.imapSecure = true;
                email.imapUser = email.smtpUser;
                email.imapPass = email.smtpPass;
            } else {
                email.imapHost = await ask(i18n.emailConfig.imapHost, existingEnv.IMAP_HOST || '');
                email.imapPort = await ask(i18n.emailConfig.imapPort, existingEnv.IMAP_PORT || '993');
                email.imapSecure = await askYesNo(i18n.emailConfig.imapSecure, existingEnv.IMAP_SECURE === 'true' || existingEnv.IMAP_SECURE === undefined);
                email.imapUser = await ask(i18n.emailConfig.imapUser, existingEnv.IMAP_USER || email.smtpUser || '');
                email.imapPass = await ask(i18n.emailConfig.imapPass, existingEnv.IMAP_PASS || email.smtpPass || '');
            }
        }

        email.checkInterval = await ask(i18n.emailConfig.checkInterval, existingEnv.CHECK_INTERVAL || '20');
    }

    // Telegram Configuration
    const telegramEnabled: boolean = await askYesNo(`${icons.telegram} ${i18n.enableTelegram}`, existingEnv.TELEGRAM_ENABLED === 'true');
    const telegram: Record<string, any> = {};
    if (telegramEnabled) {
        printSection('Telegram Configuration', icons.telegram);
        telegram.botToken = await ask(i18n.telegramConfig.botToken, existingEnv.TELEGRAM_BOT_TOKEN || '');
        telegram.chatId = await ask(i18n.telegramConfig.chatId, existingEnv.TELEGRAM_CHAT_ID || '');
        telegram.groupId = await ask(i18n.telegramConfig.groupId, existingEnv.TELEGRAM_GROUP_ID || '');
        telegram.whitelist = await ask(i18n.telegramConfig.whitelist, existingEnv.TELEGRAM_WHITELIST || '');
        telegram.webhookUrl = await ask(i18n.telegramConfig.webhookUrl, existingEnv.TELEGRAM_WEBHOOK_URL || '');
        telegram.webhookPort = await ask(i18n.telegramConfig.webhookPort, existingEnv.TELEGRAM_WEBHOOK_PORT || '3001');
        telegram.forceIPv4 = await askYesNo(i18n.telegramConfig.forceIPv4, existingEnv.TELEGRAM_FORCE_IPV4 === 'true');
    }

    // LINE Configuration
    const lineEnabled: boolean = await askYesNo(`${icons.line} ${i18n.enableLine}`, existingEnv.LINE_ENABLED === 'true');
    const line: Record<string, any> = {};
    if (lineEnabled) {
        printSection('LINE Configuration', icons.line);
        line.channelAccessToken = await ask(i18n.lineConfig.channelAccessToken, existingEnv.LINE_CHANNEL_ACCESS_TOKEN || '');
        line.channelSecret = await ask(i18n.lineConfig.channelSecret, existingEnv.LINE_CHANNEL_SECRET || '');
        line.userId = await ask(i18n.lineConfig.userId, existingEnv.LINE_USER_ID || '');
        line.groupId = await ask(i18n.lineConfig.groupId, existingEnv.LINE_GROUP_ID || '');
        line.whitelist = await ask(i18n.lineConfig.whitelist, existingEnv.LINE_WHITELIST || '');
        line.webhookPort = await ask(i18n.lineConfig.webhookPort, existingEnv.LINE_WEBHOOK_PORT || '3000');
    }

    const envValues: Record<string, string> = {
        EMAIL_ENABLED: emailEnabled ? 'true' : 'false',
        ...(emailEnabled ? {
            SMTP_HOST: email.smtpHost,
            SMTP_PORT: email.smtpPort,
            SMTP_SECURE: email.smtpSecure ? 'true' : 'false',
            SMTP_USER: email.smtpUser,
            SMTP_PASS: email.smtpPass,
            EMAIL_FROM: email.emailFrom,
            EMAIL_FROM_NAME: email.emailFromName,
            IMAP_HOST: email.imapHost,
            IMAP_PORT: email.imapPort,
            IMAP_SECURE: email.imapSecure ? 'true' : 'false',
            IMAP_USER: email.imapUser,
            IMAP_PASS: email.imapPass,
            EMAIL_TO: email.emailTo,
            ALLOWED_SENDERS: email.allowedSenders,
            CHECK_INTERVAL: email.checkInterval
        } : {}),
        TELEGRAM_ENABLED: telegramEnabled ? 'true' : 'false',
        ...(telegramEnabled ? {
            TELEGRAM_BOT_TOKEN: telegram.botToken,
            TELEGRAM_CHAT_ID: telegram.chatId,
            TELEGRAM_GROUP_ID: telegram.groupId,
            TELEGRAM_WHITELIST: telegram.whitelist,
            TELEGRAM_WEBHOOK_URL: telegram.webhookUrl,
            TELEGRAM_WEBHOOK_PORT: telegram.webhookPort,
            TELEGRAM_FORCE_IPV4: telegram.forceIPv4 ? 'true' : 'false'
        } : {}),
        LINE_ENABLED: lineEnabled ? 'true' : 'false',
        ...(lineEnabled ? {
            LINE_CHANNEL_ACCESS_TOKEN: line.channelAccessToken,
            LINE_CHANNEL_SECRET: line.channelSecret,
            LINE_USER_ID: line.userId,
            LINE_GROUP_ID: line.groupId,
            LINE_WHITELIST: line.whitelist,
            LINE_WEBHOOK_PORT: line.webhookPort
        } : {}),
        SESSION_MAP_PATH: sessionMapPath,
        INJECTION_MODE: injectionMode,
        LOG_LEVEL: logLevel
    };

    printSection('Saving Configuration', icons.star);
    const savedEnvPath: string = writeEnvFile(envValues, existingEnv);
    console.log('\n' + success(`${i18n.envSaved} ${savedEnvPath}`));

    // Validate bot token if Telegram was configured
    if (telegramEnabled && telegram.botToken) {
        await validateBotToken(telegram.botToken);
    }

    const updateHooks: boolean = await askYesNo(i18n.updateHooks, true);
    if (updateHooks) {
        const { settingsPath, existing, backupPath }: EnsureHooksResult = ensureHooksFile();
        if (backupPath) {
            console.log(warning(`${i18n.invalidSettings} ${backupPath}`));
        }
        console.log(success(`${existing ? i18n.hooksUpdated : i18n.hooksCreated} ${settingsPath}`));
        for (const def of HOOK_DEFINITIONS) {
            const label: string = def.matcher ? `${def.event} (${def.matcher})` : def.event;
            console.log(dim(`   ${label} \u2192 ${makeHookCommand(def)}`));
        }
    } else {
        console.log(warning(i18n.hooksSkipped));
    }

    // Service setup instructions
    printServiceInstructions();

    // Print copy-paste JSON block
    const hooksJSON: Record<string, HookEntry[]> = buildHooksJSON();
    console.log('\n' + bold(lang === 'en'
        ? 'Copy-paste hooks for ~/.claude/settings.json:'
        : 'Copy-paste hooks for ~/.claude/settings.json:'));
    console.log(color('\u2500'.repeat(60), 'gray'));
    console.log(dim(JSON.stringify({ hooks: hooksJSON }, null, 2)));
    console.log(color('\u2500'.repeat(60), 'gray'));

    rl.close();

    console.log('\n' + bold(color('\u2500'.repeat(60), 'gray')));
    console.log(bold(color(`${icons.rocket} ${i18n.setupComplete}`, 'green')));
    console.log(color('\u2500'.repeat(60), 'gray'));
    console.log(`  ${icons.bullet} ${i18n.nextStep1}`);
    console.log(`  ${icons.bullet} ${i18n.nextStep2}`);
    console.log();
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(error(`${i18n?.setupFailed || 'Setup failed:'} ${message}`));
    rl.close();
    process.exit(1);
});
