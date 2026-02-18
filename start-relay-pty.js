#!/usr/bin/env node

/**
 * CCGram PTY Relay Startup Script
 * Start node-pty based email command relay service
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Check environment configuration
function checkConfig() {
    const envPath = path.join(__dirname, '.env');
    
    if (!fs.existsSync(envPath)) {
        console.error('❌ Error: .env configuration file not found');
        console.log('\nPlease first copy .env.example to .env and configure your email information:');
        console.log('  cp .env.example .env');
        console.log('  Then edit .env file to fill in your email configuration\n');
        process.exit(1);
    }
    
    // Load environment variables
    require('dotenv').config();
    
    // Check required configuration
    const required = ['IMAP_HOST', 'IMAP_USER', 'IMAP_PASS'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
        console.error('❌ Error: Missing required environment variables:');
        missing.forEach(key => console.log(`  - ${key}`));
        console.log('\nPlease edit .env file and fill in all required configurations\n');
        process.exit(1);
    }
    
    console.log('✅ Configuration check passed');
    console.log(`📧 IMAP server: ${process.env.IMAP_HOST}`);
    console.log(`👤 Email account: ${process.env.IMAP_USER}`);
    console.log(`🔒 Whitelist senders: ${process.env.ALLOWED_SENDERS || '(Not set, will accept all emails)'}`);
    console.log(`💾 Session storage path: ${process.env.SESSION_MAP_PATH || '(Using default path)'}`);
    console.log('');
}

// Create example session
function createExampleSession() {
    const sessionMapPath = process.env.SESSION_MAP_PATH || path.join(__dirname, 'src/data/session-map.json');
    const sessionDir = path.dirname(sessionMapPath);
    
    // Ensure directory exists
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    // If session file doesn't exist, create an example
    if (!fs.existsSync(sessionMapPath)) {
        const exampleToken = 'TEST123';
        const exampleSession = {
            [exampleToken]: {
                type: 'pty',
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000), // Expires after 24 hours
                cwd: process.cwd(),
                description: 'Test session - Include [CCGram #TEST123] in email subject when sending'
            }
        };
        
        fs.writeFileSync(sessionMapPath, JSON.stringify(exampleSession, null, 2));
        console.log(`📝 Created example session file: ${sessionMapPath}`);
        console.log(`🔑 Test Token: ${exampleToken}`);
        console.log('   When sending test email, include in subject: [CCGram #TEST123]');
        console.log('');
    }
}

// PID file path
const PID_FILE = path.join(__dirname, 'relay-pty.pid');

// Check if an instance is already running
function checkSingleInstance() {
    if (fs.existsSync(PID_FILE)) {
        try {
            const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8'));
            // Check if process is actually running
            process.kill(oldPid, 0);
            // If no error thrown, process is still running
            console.error('❌ Error: relay-pty service is already running (PID: ' + oldPid + ')');
            console.log('\nIf you\'re sure the service is not running, you can delete the PID file:');
            console.log('  rm ' + PID_FILE);
            console.log('\nOr stop existing service:');
            console.log('  kill ' + oldPid);
            process.exit(1);
        } catch (err) {
            // Process doesn't exist, delete old PID file
            fs.unlinkSync(PID_FILE);
        }
    }
    
    // Write current process PID
    fs.writeFileSync(PID_FILE, process.pid.toString());
}

// Clean up PID file
function cleanupPidFile() {
    if (fs.existsSync(PID_FILE)) {
        fs.unlinkSync(PID_FILE);
    }
}

// Start service
function startService() {
    // Check single instance
    checkSingleInstance();
    
    console.log('🚀 Starting CCGram PTY Relay service...\n');
    
    const relayPath = path.join(__dirname, 'src/relay/relay-pty.js');
    
    // Use node to run directly, so we can see complete log output
    const relay = spawn('node', [relayPath], {
        stdio: 'inherit',
        env: {
            ...process.env,
            INJECTION_MODE: 'pty'
        }
    });
    
    // Handle exit
    process.on('SIGINT', () => {
        console.log('\n⏹️  Stopping service...');
        relay.kill('SIGINT');
        cleanupPidFile();
        process.exit(0);
    });
    
    process.on('exit', cleanupPidFile);
    process.on('SIGTERM', cleanupPidFile);
    
    relay.on('error', (error) => {
        console.error('❌ Startup failed:', error.message);
        cleanupPidFile();
        process.exit(1);
    });
    
    relay.on('exit', (code, signal) => {
        cleanupPidFile();
        if (signal) {
            console.log(`\nService stopped (signal: ${signal})`);
        } else if (code !== 0) {
            console.error(`\nService exited abnormally (code: ${code})`);
            process.exit(code);
        }
    });
}

// Show usage instructions
function showInstructions() {
    console.log('📖 Usage instructions:');
    console.log('1. When executing tasks in Claude Code, reminder emails containing Token will be sent');
    console.log('2. Reply to that email with the commands to execute');
    console.log('3. Supported command formats:');
    console.log('   - Enter command text directly');
    console.log('   - Use CMD: prefix, like "CMD: continue"');
    console.log('   - Use code block wrapping, like:');
    console.log('     ```');
    console.log('     your command');
    console.log('     ```');
    console.log('4. System will automatically extract commands and inject them into corresponding Claude Code session');
    console.log('\n⌨️  Press Ctrl+C to stop service\n');
    console.log('━'.repeat(60) + '\n');
}

// Main function
function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║         CCGram PTY Relay Service              ║');
    console.log('║      Email Command Relay Service - node-pty based PTY mode          ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
    
    // Check configuration
    checkConfig();
    
    // Create example session
    createExampleSession();
    
    // Show usage instructions
    showInstructions();
    
    // Start service
    startService();
}

// Run
main();