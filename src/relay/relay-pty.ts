#!/usr/bin/env node

/**
 * relay-pty.ts - Fixed version
 * Uses node-imap instead of ImapFlow to resolve Feishu email compatibility issues
 */

import path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import dotenv from 'dotenv';
import { PROJECT_ROOT } from '../utils/paths';
import { optionalRequire } from '../utils/optional-require';

const envPath = path.join(PROJECT_ROOT, '.env');
dotenv.config({ path: envPath });

const Imap = optionalRequire('node-imap', 'IMAP email relay') as any;
const mailparserModule = optionalRequire('mailparser', 'email parsing') as any;
const simpleParser = mailparserModule ? mailparserModule.simpleParser : null;
const nodePty = optionalRequire('node-pty', 'PTY terminal emulation') as any;
const _spawn = nodePty ? nodePty.spawn : null;
const pinoModule = optionalRequire('pino', 'structured logging') as any;

interface LogMethods {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}

interface ParsedEmail {
    uid?: number;
    messageId?: string;
    subject?: string;
    text?: string;
    date?: Date;
    from?: { text?: string };
}

interface AutoPasteResult {
    success: boolean;
    method?: string;
    error?: string;
}

interface SessionEntry {
    tmuxSession?: string;
    expiresAt?: number;
    [key: string]: unknown;
}

interface ProcessedMessageRecord {
    id: string | number;
    timestamp: number;
}

interface SentMessageRecord {
    messageId: string;
    sentAt: string;
}

interface SentMessagesFile {
    messages: SentMessageRecord[];
}

// Configure logging with fallback to console
let log: LogMethods;
if (pinoModule) {
    const pinoPretty = optionalRequire('pino-pretty', 'log formatting');
    if (pinoPretty) {
        log = pinoModule({
            level: process.env.LOG_LEVEL || 'info',
            transport: {
                target: 'pino-pretty',
                options: { colorize: true, translateTime: 'HH:MM:ss' }
            }
        });
    } else {
        log = pinoModule({ level: process.env.LOG_LEVEL || 'info' });
    }
} else {
    const logLevel = process.env.LOG_LEVEL || 'info';
    const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    const minLevel = levels[logLevel] ?? 1;
    log = {
        debug: (...args: unknown[]) => { if (minLevel <= 0) console.log('[DEBUG]', ...args); },
        info: (...args: unknown[]) => { if (minLevel <= 1) console.log('[INFO]', ...args); },
        warn: (...args: unknown[]) => { if (minLevel <= 2) console.warn('[WARN]', ...args); },
        error: (...args: unknown[]) => { if (minLevel <= 3) console.error('[ERROR]', ...args); },
    };
}

// Global configuration
const SESS_PATH = process.env.SESSION_MAP_PATH || path.join(PROJECT_ROOT, 'src/data/session-map.json');
const PROCESSED_PATH = path.join(PROJECT_ROOT, 'src/data/processed-messages.json');
const SENT_MESSAGES_PATH = path.join(PROJECT_ROOT, 'src/data/sent-messages.json');
const ALLOWED_SENDERS = (process.env.ALLOWED_SENDERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const PTY_POOL = new Map<string, unknown>();
let PROCESSED_MESSAGES = new Set<string | number>();

// Load processed messages
function loadProcessedMessages(): void {
    if (existsSync(PROCESSED_PATH)) {
        try {
            const data: ProcessedMessageRecord[] = JSON.parse(readFileSync(PROCESSED_PATH, 'utf8'));
            const now = Date.now();
            // Keep only records from the last 7 days
            const validMessages = data.filter(item => (now - item.timestamp) < 7 * 24 * 60 * 60 * 1000);
            PROCESSED_MESSAGES = new Set(validMessages.map(item => item.id));
            // Update file, remove expired records
            saveProcessedMessages();
        } catch (error: unknown) {
            log.error({ error }, 'Failed to load processed messages');
            PROCESSED_MESSAGES = new Set();
        }
    }
}

// Save processed messages
function saveProcessedMessages(): void {
    try {
        const now = Date.now();
        const data = Array.from(PROCESSED_MESSAGES).map(id => ({
            id,
            timestamp: now
        }));

        // Ensure directory exists
        const dir = path.dirname(PROCESSED_PATH);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        writeFileSync(PROCESSED_PATH, JSON.stringify(data, null, 2));
    } catch (error: unknown) {
        log.error({ error }, 'Failed to save processed messages');
    }
}

// Load session mapping
function loadSessions(): Record<string, SessionEntry> {
    if (!existsSync(SESS_PATH)) return {};
    try {
        return JSON.parse(readFileSync(SESS_PATH, 'utf8'));
    } catch (error: unknown) {
        log.error({ error }, 'Failed to load session map');
        return {};
    }
}

// Check if sender is in whitelist
function isAllowed(fromAddress: string): boolean {
    if (!fromAddress) return false;
    const addr = fromAddress.toLowerCase();
    return ALLOWED_SENDERS.some(allowed => addr.includes(allowed));
}

// Extract CCGram token from subject
function extractTokenFromSubject(subject: string = ''): string | null {
    const patterns = [
        /\[CCGram\s+#([A-Z0-9]+)\]/,
        /Re:\s*\[CCGram\s+#([A-Z0-9]+)\]/
    ];

    for (const pattern of patterns) {
        const match = subject.match(pattern);
        if (match) return match[1];
    }

    return null;
}

// Clean email text
function cleanEmailText(text: string = ''): string {
    const lines = text.split(/\r?\n/);
    const cleanLines: string[] = [];

    for (const line of lines) {
        // Detect quoted content (more comprehensive detection)
        if (line.includes('-----Original Message-----') ||
            line.includes('--- Original Message ---') ||
            line.includes('at') && line.includes('wrote:') ||
            line.includes('On') && line.includes('wrote:') ||
            line.includes('Session ID:') ||
            line.includes(`<${process.env.SMTP_USER}>`) ||
            line.includes('CCGram Notification System') ||
            line.includes('on 2025') && line.includes('wrote:') ||
            line.match(/^>.*/) ||  // Quote lines start with >
            line.includes('From:') && line.includes('@') ||
            line.includes('To:') && line.includes('@') ||
            line.includes('Subject:') ||
            line.includes('Sent:') ||
            line.includes('Date:')) {
            break;
        }

        // Detect email signature
        if (line.match(/^--\s*$/) ||
            line.includes('Sent from') ||
            line.includes('Sent from my') ||
            line.includes('Best regards') ||
            line.includes('Sincerely')) {
            break;
        }

        cleanLines.push(line);
    }

    // Get valid content
    const cleanText = cleanLines.join('\n').trim();

    // Find actual command content (skip greetings, etc.)
    const contentLines = cleanText.split(/\r?\n/).filter(l => l.trim().length > 0);

    // Collect all valid command lines (support multi-line commands)
    const validCommandLines: string[] = [];

    for (const line of contentLines) {
        const trimmedLine = line.trim();

        // Skip common greetings (but only if they're standalone)
        if (trimmedLine.match(/^(hi|hello|thank you|thanks|ok|yes)$/i)) {
            continue;
        }

        // Skip remaining email quotes
        if (trimmedLine.includes('CCGram Notification System') ||
            trimmedLine.includes(`<${process.env.SMTP_USER}>`) ||
            trimmedLine.includes('on 2025')) {
            continue;
        }

        // Collect valid command lines
        if (trimmedLine.length > 0) {
            validCommandLines.push(trimmedLine);
        }
    }

    // Join all valid lines to form the complete command
    if (validCommandLines.length > 0) {
        const fullCommand = validCommandLines.join('\n').slice(0, 8192);
        const deduplicatedCommand = deduplicateCommand(fullCommand);
        return deduplicatedCommand;
    }

    // If no obvious command is found, return first non-empty line (and deduplicate)
    const firstLine = contentLines[0] || '';
    const command = firstLine.slice(0, 8192).trim();
    return deduplicateCommand(command);
}

// Deduplicate command text (handle cases like: "drink cola okay drink cola okay" -> "drink cola okay")
function deduplicateCommand(command: string): string {
    if (!command || command.length === 0) {
        return command;
    }

    // Check if command is self-repeating
    const length = command.length;
    for (let i = 1; i <= Math.floor(length / 2); i++) {
        const firstPart = command.substring(0, i);
        const remaining = command.substring(i);

        // Check if remaining part completely repeats the first part
        if (remaining === firstPart.repeat(Math.floor(remaining.length / firstPart.length))) {
            // Found repetition pattern, return first part
            log.debug({
                originalCommand: command,
                deduplicatedCommand: firstPart,
                pattern: firstPart
            }, 'Detected and removed command duplication');
            return firstPart;
        }
    }

    // No repetition detected, return original command
    return command;
}

// Unattended remote command injection - tmux priority, smart fallback
async function injectCommandRemote(token: string, command: string): Promise<boolean> {
    const sessions = loadSessions();
    const session = sessions[token];

    if (!session) {
        log.warn({ token }, 'Session not found');
        return false;
    }

    // Check if session has expired
    const now = Math.floor(Date.now() / 1000);
    if (session.expiresAt && session.expiresAt < now) {
        log.warn({ token }, 'Session expired');
        return false;
    }

    try {
        log.info({ token, command }, 'Starting remote command injection');

        // Method 1: Prefer tmux unattended injection
        const TmuxInjector = require('./tmux-injector');
        const tmuxSessionName = session.tmuxSession || 'claude-taskping';
        const tmuxInjector = new TmuxInjector(log, tmuxSessionName);

        const tmuxResult = await tmuxInjector.injectCommandFull(token, command);

        if (tmuxResult.success) {
            log.info({ token, session: tmuxResult.session }, 'Tmux remote injection successful');
            return true;
        } else {
            log.warn({ token, error: tmuxResult.error }, 'Tmux injection failed, trying smart fallback');

            // Method 2: Fall back to smart injector
            const SmartInjector = require('./smart-injector');
            const smartInjector = new SmartInjector(log);

            const smartResult = await smartInjector.injectCommand(token, command);

            if (smartResult) {
                log.info({ token }, 'Smart injection fallback successful');
                return true;
            } else {
                log.error({ token }, 'All remote injection methods failed');
                return false;
            }
        }

    } catch (error: unknown) {
        log.error({ error, token }, 'Failed to inject command remotely');
        return false;
    }
}

// Try automatic paste to active window
async function tryAutoPaste(command: string): Promise<AutoPasteResult> {
    return new Promise((resolve) => {
        // First copy command to clipboard
        const { spawn } = require('child_process');
        const pbcopy = spawn('pbcopy');
        pbcopy.stdin.write(command);
        pbcopy.stdin.end();

        pbcopy.on('close', (code: number) => {
            if (code !== 0) {
                resolve({ success: false, error: 'clipboard_copy_failed' });
                return;
            }

            // Execute AppleScript auto-paste
            const autoScript = `
            tell application "System Events"
                set claudeApps to {"Claude", "Claude Code", "Terminal", "iTerm2", "iTerm"}
                set targetApp to null
                set targetName to ""

                repeat with appName in claudeApps
                    try
                        if application process appName exists then
                            set targetApp to application process appName
                            set targetName to appName
                            exit repeat
                        end if
                    end try
                end repeat

                if targetApp is not null then
                    set frontmost of targetApp to true
                    delay 0.8

                    repeat 10 times
                        if frontmost of targetApp then exit repeat
                        delay 0.1
                    end repeat

                    if targetName is in {"Terminal", "iTerm2", "iTerm"} then
                        keystroke "${command.replace(/"/g, '\\"')}"
                        delay 0.3
                        keystroke return
                        return "terminal_typed"
                    else
                        keystroke "a" using command down
                        delay 0.2
                        keystroke "v" using command down
                        delay 0.5
                        keystroke return
                        return "claude_pasted"
                    end if
                else
                    return "no_target_found"
                end if
            end tell
            `;

            const { exec } = require('child_process');
            exec(`osascript -e '${autoScript}'`, (error: Error | null, stdout: string, _stderr: string) => {
                if (error) {
                    resolve({ success: false, error: error.message });
                    return;
                }

                const result = stdout.trim();

                switch(result) {
                    case 'terminal_typed':
                        resolve({ success: true, method: 'Terminal direct input' });
                        break;
                    case 'claude_pasted':
                        resolve({ success: true, method: 'Claude app paste' });
                        break;
                    case 'no_target_found':
                        resolve({ success: false, error: 'no_target_application' });
                        break;
                    default:
                        resolve({ success: false, error: `unknown_result: ${result}` });
                }
            });
        });
    });
}

// Fallback to clipboard + strong reminder
async function fallbackToClipboard(command: string): Promise<boolean> {
    return new Promise((resolve) => {
        // Copy to clipboard
        const { spawn } = require('child_process');
        const pbcopy = spawn('pbcopy');
        pbcopy.stdin.write(command);
        pbcopy.stdin.end();

        pbcopy.on('close', (code: number) => {
            if (code !== 0) {
                resolve(false);
                return;
            }

            // Send strong reminder notification
            const shortCommand = command.length > 30 ? command.substring(0, 30) + '...' : command;
            const notificationScript = `
                display notification "\u{1f6a8} Email command auto-copied! Please paste and execute in Claude Code immediately (Cmd+V)" with title "TaskPing Auto-Injection" subtitle "${shortCommand.replace(/"/g, '\\"')}" sound name "Basso"
            `;

            const { exec } = require('child_process');
            exec(`osascript -e '${notificationScript}'`, (error: Error | null) => {
                if (error) {
                    log.warn({ error: error.message }, 'Failed to send notification');
                } else {
                    log.info('Strong reminder notification sent');
                }
                resolve(true);
            });
        });
    });
}

// Handle email message
async function handleMailMessage(parsed: ParsedEmail): Promise<void> {
    try {
        log.debug({ uid: parsed.uid, messageId: parsed.messageId }, 'handleMailMessage called');

        // Check if this is a system-sent email
        const messageId = parsed.messageId;
        if (await isSystemSentEmail(messageId)) {
            log.info({ messageId }, 'Skipping system-sent email');
            await removeFromSentMessages(messageId!);
            return;
        }

        // Simplified duplicate detection (UID already checked earlier)
        const uid = parsed.uid;

        // Only perform additional checks for emails without UID
        if (!uid) {
            const identifier = messageId;
            if (identifier && PROCESSED_MESSAGES.has(identifier)) {
                log.debug({ messageId, identifier }, 'Message already processed by messageId, skipping');
                return;
            }

            // Content hash deduplication (as last resort)
            const emailSubject = parsed.subject || '';
            const emailDate = parsed.date || new Date();
            const contentHash = `${emailSubject}_${emailDate.getTime()}`;

            if (PROCESSED_MESSAGES.has(contentHash)) {
                log.debug({ subject: emailSubject, date: emailDate, contentHash }, 'Message already processed by content hash, skipping');
                return;
            }
        }

        // Verify sender
        if (!isAllowed(parsed.from?.text || '')) {
            log.warn({ from: parsed.from?.text }, 'Sender not allowed');
            return;
        }

        // Extract token
        const subject = parsed.subject || '';
        const token = extractTokenFromSubject(subject);

        if (!token) {
            log.warn({ subject }, 'No token found in email');
            return;
        }

        // Extract command - add detailed debugging
        log.debug({
            token,
            rawEmailText: parsed.text?.substring(0, 500),
            emailSubject: parsed.subject
        }, 'Raw email content before cleaning');

        const command = cleanEmailText(parsed.text);

        log.debug({
            token,
            cleanedCommand: command,
            commandLength: command?.length
        }, 'Email content after cleaning');

        if (!command) {
            log.warn({ token }, 'No command found in email');
            return;
        }

        log.info({ token, command }, 'Processing email command');

        // Unattended remote command injection (tmux priority, smart fallback)
        const success = await injectCommandRemote(token, command);

        if (!success) {
            log.warn({ token }, 'Could not inject command');
            return;
        }

        // Mark as processed (only mark after successful processing)
        if (uid) {
            // Mark UID as processed
            PROCESSED_MESSAGES.add(uid);
            log.debug({ uid }, 'Marked message UID as processed');
        } else {
            // For emails without UID, use messageId and content hash
            if (messageId) {
                PROCESSED_MESSAGES.add(messageId);
                log.debug({ messageId }, 'Marked message as processed by messageId');
            }

            // Content hash marking
            const emailSubject = parsed.subject || '';
            const emailDate = parsed.date || new Date();
            const contentHash = `${emailSubject}_${emailDate.getTime()}`;
            PROCESSED_MESSAGES.add(contentHash);
            log.debug({ contentHash }, 'Marked message as processed by content hash');
        }

        // Persist processed messages
        saveProcessedMessages();

        log.info({ token }, 'Command injected successfully via remote method');

    } catch (error: unknown) {
        log.error({ error }, 'Failed to handle email message');
    }
}

// Start IMAP listening
function startImap(): void {
    if (!Imap) {
        console.error('Error: node-imap is required for the email relay. Install with: npm install node-imap');
        process.exit(1);
    }
    if (!simpleParser) {
        console.error('Error: mailparser is required for the email relay. Install with: npm install mailparser');
        process.exit(1);
    }

    // First load processed messages
    loadProcessedMessages();

    log.info('Starting relay-pty service', {
        mode: 'pty',
        imapHost: process.env.IMAP_HOST,
        imapUser: process.env.IMAP_USER,
        allowedSenders: ALLOWED_SENDERS,
        sessionMapPath: SESS_PATH,
        processedCount: PROCESSED_MESSAGES.size
    });

    const imap = new Imap({
        user: process.env.IMAP_USER,
        password: process.env.IMAP_PASS,
        host: process.env.IMAP_HOST,
        port: parseInt(process.env.IMAP_PORT || '993') || 993,
        tls: process.env.IMAP_SECURE === 'true',
        connTimeout: 60000,
        authTimeout: 30000,
        keepalive: true
    });

    imap.once('ready', function() {
        log.info('Connected to IMAP server');

        imap.openBox('INBOX', false, function(err: Error | null, box: any) {
            if (err) {
                log.error({ error: err.message }, 'Failed to open INBOX');
                return;
            }

            log.info(`Mailbox opened: ${box.messages.total} total messages, ${box.messages.new} new`);

            // Only process existing unread emails at startup
            processExistingEmails(imap);

            // Listen for new emails (main mechanism)
            imap.on('mail', function(numNewMsgs: number) {
                log.info({ newMessages: numNewMsgs }, 'New mail arrived');
                // Add delay to avoid conflicts with existing email processing
                setTimeout(() => {
                    processNewEmails(imap);
                }, 1000);
            });

            // Periodic check for new emails (backup only, extended interval)
            setInterval(() => {
                log.debug('Periodic email check...');
                processNewEmails(imap);
            }, 120000); // Check every 2 minutes, reduced frequency
        });
    });

    imap.once('error', function(err: Error) {
        log.error({ error: err.message }, 'IMAP error');
        // Reconnection mechanism
        setTimeout(() => {
            log.info('Attempting to reconnect...');
            startImap();
        }, 10000);
    });

    imap.once('end', function() {
        log.info('IMAP connection ended');
    });

    imap.connect();

    // Graceful shutdown
    process.on('SIGINT', () => {
        log.info('Shutting down gracefully...');
        imap.end();
        process.exit(0);
    });
}

// Process existing emails
function processExistingEmails(imap: any): void {
    // Search unread emails
    imap.search(['UNSEEN'], function(err: Error | null, results: number[]) {
        if (err) {
            log.error({ error: err.message }, 'Failed to search emails');
            return;
        }

        if (results.length > 0) {
            log.info(`Found ${results.length} unread messages`);
            log.debug({ uids: results }, 'Unread message UIDs');
            fetchAndProcessEmails(imap, results);
        } else {
            log.debug('No unread messages found');
        }
    });
}

// Process new emails
function processNewEmails(imap: any): void {
    // Search emails from the last 5 minutes
    const since = new Date();
    since.setMinutes(since.getMinutes() - 5);
    const sinceStr = since.toISOString().split('T')[0]; // YYYY-MM-DD

    imap.search([['SINCE', sinceStr], 'UNSEEN'], function(err: Error | null, results: number[]) {
        if (err) {
            log.error({ error: err.message }, 'Failed to search new emails');
            return;
        }

        if (results.length > 0) {
            log.info(`Found ${results.length} new messages`);
            fetchAndProcessEmails(imap, results);
        }
    });
}

// Fetch and process emails
function fetchAndProcessEmails(imap: any, uids: number[]): void {
    log.debug({ uids }, 'Starting to fetch emails');
    const fetch = imap.fetch(uids, {
        bodies: '',  // Get complete email
        markSeen: true  // Mark as read
    });

    fetch.on('message', function(msg: any, seqno: number) {
        let buffer = '';
        let messageUid: number | null = null;
        let skipProcessing = false;
        let bodyProcessed = false;
        let attributesReceived = false;

        // Get UID to prevent duplicate processing
        msg.once('attributes', function(attrs: { uid: number }) {
            messageUid = attrs.uid;
            attributesReceived = true;
            log.debug({ uid: messageUid, seqno }, 'Received attributes');

            // Only check if already processed, don't mark immediately
            if (messageUid && PROCESSED_MESSAGES.has(messageUid)) {
                log.debug({ uid: messageUid, seqno }, 'Message UID already processed, skipping entire message');
                skipProcessing = true;
                return; // Return directly, do not continue processing
            }
            log.debug({ uid: messageUid, seqno }, 'Message UID ready for processing');

            // If body is processed, can now parse email
            if (bodyProcessed && !skipProcessing) {
                processEmailBuffer(buffer, messageUid, seqno);
            }
        });

        msg.on('body', function(stream: any, _info: unknown) {
            stream.on('data', function(chunk: Buffer) {
                buffer += chunk.toString('utf8');
            });

            stream.once('end', function() {
                bodyProcessed = true;
                log.debug({ uid: messageUid, seqno, bufferLength: buffer.length, attributesReceived }, 'Body stream ended');

                // If attributes received and not marked to skip, can now parse email
                if (attributesReceived && !skipProcessing) {
                    processEmailBuffer(buffer, messageUid, seqno);
                }
            });
        });

        // Separated email processing function
        function processEmailBuffer(buffer: string, uid: number | null, seqno: number): void {
            if (buffer.length > 0 && uid) {
                log.debug({ uid, seqno }, 'Starting email parsing');
                simpleParser(buffer, function(err: Error | null, parsed: ParsedEmail) {
                    if (err) {
                        log.error({ error: err.message, seqno, uid }, 'Failed to parse email');
                        PROCESSED_MESSAGES.delete(uid);
                    } else {
                        log.debug({ uid, seqno }, 'Email parsed successfully, calling handleMailMessage');
                        parsed.uid = uid;
                        handleMailMessage(parsed);
                    }
                });
            } else {
                log.debug({ uid, seqno, bufferLength: buffer.length }, 'Skipping email - no buffer or uid');
            }
        }

        msg.once('error', function(err: Error) {
            log.error({ error: err.message, seqno, uid: messageUid }, 'Error fetching message');
        });
    });

    fetch.once('error', function(err: Error) {
        log.error({ error: err.message }, 'Error fetching emails');
    });

    fetch.once('end', function() {
        log.debug('Email fetch completed');
    });
}

// Check if email is system-sent
async function isSystemSentEmail(messageId: string | undefined): Promise<boolean> {
    if (!messageId || !existsSync(SENT_MESSAGES_PATH)) {
        return false;
    }

    try {
        const sentMessages: SentMessagesFile = JSON.parse(readFileSync(SENT_MESSAGES_PATH, 'utf8'));
        return sentMessages.messages.some(msg => msg.messageId === messageId);
    } catch (error: unknown) {
        log.error({ error }, 'Error reading sent messages');
        return false;
    }
}

// Remove email from sent messages tracking
async function removeFromSentMessages(messageId: string): Promise<void> {
    if (!existsSync(SENT_MESSAGES_PATH)) {
        return;
    }

    try {
        const sentMessages: SentMessagesFile = JSON.parse(readFileSync(SENT_MESSAGES_PATH, 'utf8'));
        sentMessages.messages = sentMessages.messages.filter(msg => msg.messageId !== messageId);

        // Also clean up old messages (older than 24 hours)
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        sentMessages.messages = sentMessages.messages.filter(msg => {
            return new Date(msg.sentAt) > oneDayAgo;
        });

        writeFileSync(SENT_MESSAGES_PATH, JSON.stringify(sentMessages, null, 2));
        log.debug({ messageId }, 'Removed message from sent tracking');
    } catch (error: unknown) {
        log.error({ error }, 'Error removing from sent messages');
    }
}

// Start service
if (require.main === module) {
    startImap();
}

export { startImap, handleMailMessage, extractTokenFromSubject, cleanEmailText };
