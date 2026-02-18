/**
 * CCGram Configuration Manager
 * Interactive configuration tool for managing settings
 */

const readline = require('readline');
const Logger = require('../core/logger');

class ConfigurationManager {
    constructor(configManager) {
        this.config = configManager;
        this.logger = new Logger('ConfigManager');
        
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        // Enable keypress events
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        readline.emitKeypressEvents(process.stdin, this.rl);
    }

    async run(args = []) {
        if (args.includes('--help') || args.includes('-h')) {
            this.showHelp();
            this.rl.close();
            return;
        }

        if (args.includes('--show')) {
            this.displayCurrentConfig();
            this.rl.close();
            return;
        }

        await this.showMainMenu();
    }

    async question(prompt) {
        return new Promise((resolve) => {
            this.rl.question(prompt, resolve);
        });
    }

    displayCurrentConfig() {
        console.log('\nCurrent configuration:');
        console.log('├─ Language:', this.config.get('language'));
        console.log('├─ Enabled status:', this.config.get('enabled') ? 'Enabled' : 'Disabled');
        console.log('├─ Timeout:', this.config.get('timeout') + ' seconds');
        console.log('├─ Completion sound:', this.config.get('sound.completed'));
        console.log('└─ Waiting sound:', this.config.get('sound.waiting'));
        console.log();
    }

    async showMainMenu() {
        while (true) {
            console.log('\n=== CCGram Configuration Manager ===');
            this.displayCurrentConfig();
            console.log('Options:');
            console.log('1. Basic Settings');
            console.log('2. Sound Configuration');
            console.log('3. Notification Channels');
            console.log('4. Command Relay');
            console.log('5. Test Notifications');
            console.log('6. Save and Exit');
            console.log('7. Exit (without saving)');

            const choice = await this.question('\nPlease select (1-7): ');

            switch (choice) {
                case '1':
                    await this.configureBasicSettings();
                    break;
                case '2':
                    await this.configureSounds();
                    break;
                case '3':
                    await this.configureChannels();
                    break;
                case '4':
                    await this.configureRelay();
                    break;
                case '5':
                    await this.testNotifications();
                    break;
                case '6':
                    if (this.config.save()) {
                        console.log('✅ Configuration saved');
                        this.rl.close();
                        return;
                    } else {
                        console.log('❌ Save failed');
                    }
                    break;
                case '7':
                    console.log('Exit (changes not saved)');
                    this.rl.close();
                    return;
                default:
                    console.log('❌ Invalid selection');
            }
        }
    }

    async configureBasicSettings() {
        console.log('\n=== Basic Settings ===');
        console.log('1. Configure Language');
        console.log('2. Toggle Enabled Status');
        console.log('3. Configure Timeout');
        console.log('4. Custom Messages');
        console.log('0. Return to Main Menu');

        const choice = await this.question('\n Please select (0-4): ');

        switch (choice) {
            case '1':
                await this.configureLanguage();
                break;
            case '2':
                await this.toggleEnabled();
                break;
            case '3':
                await this.configureTimeout();
                break;
            case '4':
                await this.configureCustomMessages();
                break;
            case '0':
                return;
            default:
                console.log('❌ Invalid selection');
        }
    }

    async configureLanguage() {
        const languages = ['zh-CN', 'en', 'ja'];
        console.log('\nAvailable languages:');
        languages.forEach((lang, index) => {
            console.log(`${index + 1}. ${lang}`);
        });

        const choice = await this.question(`Select language (1-${languages.length}): `);
        const index = parseInt(choice) - 1;

        if (index >= 0 && index < languages.length) {
            this.config.set('language', languages[index]);
            console.log(`✅ Language set to: ${languages[index]}`);
        } else {
            console.log('❌ Invalid selection');
        }
    }

    async toggleEnabled() {
        const current = this.config.get('enabled', true);
        this.config.set('enabled', !current);
        console.log(`✅ Notifications ${!current ? 'enabled' : 'disabled'}`);
    }

    async configureTimeout() {
        const timeout = await this.question('Set timeout (seconds): ');
        const timeoutNum = parseInt(timeout);
        if (timeoutNum > 0 && timeoutNum <= 30) {
            this.config.set('timeout', timeoutNum);
            console.log(`✅ Timeout set to: ${timeoutNum} seconds`);
        } else {
            console.log('❌ Invalid timeout (1-30 seconds)');
        }
    }

    async configureSounds() {
        // Load desktop channel to get available sounds
        const DesktopChannel = require('../channels/local/desktop');
        const desktop = new DesktopChannel();
        const soundCategories = desktop.getAvailableSounds();

        console.log('\n=== Sound Configuration ===');
        
        // Configure completed sound
        console.log('\n--- Configure Task Completion Sound ---');
        const completedSound = await this.selectSoundFromCategories(soundCategories, 'task completion');
        if (completedSound) {
            this.config.set('sound.completed', completedSound);
            console.log(`✅ Task completion sound set to: ${completedSound}`);
        }

        // Configure waiting sound
        console.log('\n--- Configure Waiting Input Sound ---');
        const waitingSound = await this.selectSoundFromCategories(soundCategories, 'waiting input');
        if (waitingSound) {
            this.config.set('sound.waiting', waitingSound);
            console.log(`✅ Waiting input sound set to: ${waitingSound}`);
        }
    }

    async selectSoundFromCategories(soundCategories, type) {
        const categories = Object.keys(soundCategories);
        
        console.log(`\nSelect ${type} sound category:`);
        categories.forEach((category, index) => {
            const count = soundCategories[category].length;
            console.log(`${index + 1}. ${category} (${count} sounds)`);
        });
        console.log('0. Skip');

        const choice = await this.question(`\nPlease select category (0-${categories.length}): `);
        const index = parseInt(choice) - 1;

        if (choice === '0') {
            return null;
        }

        if (index >= 0 && index < categories.length) {
            const category = categories[index];
            const sounds = soundCategories[category];
            return await this.selectSoundFromList(sounds, type);
        } else {
            console.log('❌ Invalid selection');
            return null;
        }
    }

    async selectSoundFromList(sounds, type) {
        console.log(`\nSelect ${type} sound:`);
        sounds.forEach((sound, index) => {
            console.log(`${index + 1}. ${sound}`);
        });
        console.log('0. Return to category selection');

        const choice = await this.question(`\nPlease select (0-${sounds.length}): `);
        const index = parseInt(choice) - 1;

        if (choice === '0') {
            return null;
        }

        if (index >= 0 && index < sounds.length) {
            const selectedSound = sounds[index];
            
            // Play sound preview
            try {
                const DesktopChannel = require('../channels/local/desktop');
                const desktop = new DesktopChannel();
                desktop._playSound(selectedSound);
                console.log(`Playing sound: ${selectedSound}`);
            } catch (error) {
                // Ignore playback errors
            }

            const confirm = await this.question('Confirm using this sound? (y/n): ');
            if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
                return selectedSound;
            }
        } else {
            console.log('❌ Invalid selection');
        }

        return null;
    }

    async configureChannels() {
        console.log('\n=== Notification Channel Configuration ===');
        console.log('1. Desktop Notifications (Enabled)');
        console.log('2. Email Notifications');
        console.log('3. Discord Notifications (Coming Soon)');
        console.log('4. Telegram Notifications (Coming Soon)');
        console.log('5. WhatsApp Notifications (Coming Soon)');
        console.log('6. Feishu Notifications (Coming Soon)');
        console.log('0. Return to Main Menu');

        const choice = await this.question('\nPlease select channel to configure (0-6): ');

        switch (choice) {
            case '1':
                console.log('\nDesktop notifications are enabled and working properly!');
                break;
            case '2':
                await this.configureEmailChannel();
                break;
            case '3':
            case '4':
            case '5':
            case '6':
                console.log('\nThis channel will be supported in future versions!');
                break;
            case '0':
                return;
            default:
                console.log('❌ Invalid selection');
        }
        
        if (choice !== '0') {
            await this.question('\nPress Enter to continue...');
        }
    }

    async configureRelay() {
        console.log('\n=== Command Relay Configuration ===');
        console.log('(This feature will be implemented in future versions)');
        console.log('Will support sending commands via notification channels and auto-executing in Claude Code');
        
        await this.question('\nPress Enter to continue...');
    }

    async configureCustomMessages() {
        console.log('\n=== Custom Message Configuration ===');
        console.log('Tip: Use {project} as project name placeholder');
        console.log('Example: [{project}] Task completed!\n');

        // Configure completed message
        const currentCompleted = this.config.get('customMessages.completed') || 'Use default text';
        console.log(`Current task completion text: ${currentCompleted}`);
        const completedMsg = await this.question('New task completion text (Enter to skip): ');
        if (completedMsg.trim()) {
            this.config.set('customMessages.completed', completedMsg.trim());
            console.log('✅ Updated task completion text');
        }

        // Configure waiting message
        const currentWaiting = this.config.get('customMessages.waiting') || 'Use default text';
        console.log(`\nCurrent waiting input text: ${currentWaiting}`);
        const waitingMsg = await this.question('New waiting input text (Enter to skip): ');
        if (waitingMsg.trim()) {
            this.config.set('customMessages.waiting', waitingMsg.trim());
            console.log('✅ Updated waiting input text');
        }
    }

    async testNotifications() {
        console.log('\n=== Test Notifications ===');
        
        try {
            const Notifier = require('../core/notifier');
            const notifier = new Notifier(this.config);
            await notifier.initializeChannels();
            
            console.log('Sending task completion notification...');
            await notifier.notify('completed', { test: true });
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            console.log('Sending waiting input notification...');
            await notifier.notify('waiting', { test: true });
            
            console.log('✅ Test completed');
        } catch (error) {
            console.error('❌ Test failed:', error.message);
        }
        
        await this.question('\nPress Enter to continue...');
    }

    async configureEmailChannel() {
        console.log('\n=== Email Notification Configuration ===');
        
        // Get current email configuration
        const currentEmailConfig = this.config.getChannel('email') || { enabled: false, config: {} };
        const emailConfig = currentEmailConfig.config || {};
        
        console.log(`Current status: ${currentEmailConfig.enabled ? '✅ Enabled' : '❌ Disabled'}`);
        
        console.log('\n📧 SMTP Sending Configuration:');
        
        // SMTP host configuration
        const currentHost = emailConfig.smtp?.host || '';
        console.log(`Current SMTP host: ${currentHost || 'Not configured'}`);
        const smtpHost = await this.question('SMTP host (e.g., smtp.gmail.com): ');
        
        // SMTP port configuration
        const currentPort = emailConfig.smtp?.port || 587;
        console.log(`Current SMTP port: ${currentPort}`);
        const smtpPortInput = await this.question('SMTP port (default 587): ');
        const smtpPort = parseInt(smtpPortInput) || 587;
        
        // Security connection configuration
        const currentSecure = emailConfig.smtp?.secure || false;
        console.log(`Current secure connection: ${currentSecure ? 'SSL/TLS' : 'STARTTLS'}`);
        const secureInput = await this.question('Use SSL/TLS? (y/n, default n): ');
        const secure = secureInput.toLowerCase() === 'y';
        
        // Username configuration
        const currentUser = emailConfig.smtp?.auth?.user || '';
        console.log(`Current username: ${currentUser || 'Not configured'}`);
        const smtpUser = await this.question('SMTP username (email address): ');
        
        // Password configuration
        console.log('SMTP password: [Hidden]');
        const smtpPass = await this.question('SMTP password (app password): ');
        
        console.log('\n📥 IMAP Receiving Configuration (for receiving replies):');
        
        // IMAP host configuration
        const currentImapHost = emailConfig.imap?.host || '';
        console.log(`Current IMAP host: ${currentImapHost || 'Not configured'}`);
        const imapHost = await this.question('IMAP host (e.g., imap.gmail.com): ');
        
        // IMAP port configuration
        const currentImapPort = emailConfig.imap?.port || 993;
        console.log(`Current IMAP port: ${currentImapPort}`);
        const imapPortInput = await this.question('IMAP port (default 993): ');
        const imapPort = parseInt(imapPortInput) || 993;
        
        // IMAP secure connection
        const currentImapSecure = emailConfig.imap?.secure !== false;
        const imapSecureInput = await this.question('IMAP use SSL? (y/n, default y): ');
        const imapSecure = imapSecureInput.toLowerCase() !== 'n';
        
        // Recipient configuration
        console.log('\n📬 Recipient Configuration:');
        const currentTo = emailConfig.to || '';
        console.log(`Current recipient: ${currentTo || 'Not configured'}`);
        const toEmail = await this.question('Recipient email: ');
        
        // Sender configuration
        const currentFrom = emailConfig.from || '';
        console.log(`Current sender: ${currentFrom || 'Not configured'}`);
        const fromEmail = await this.question(`Sender display name (default: CCGram <${smtpUser}>): `);
        
        // Build email configuration
        const newEmailConfig = {
            enabled: true,
            config: {
                smtp: {
                    host: smtpHost || currentHost,
                    port: smtpPort,
                    secure: secure,
                    auth: {
                        user: smtpUser || currentUser,
                        pass: smtpPass || emailConfig.smtp?.auth?.pass || ''
                    }
                },
                imap: {
                    host: imapHost || currentImapHost,
                    port: imapPort,
                    secure: imapSecure,
                    auth: {
                        user: smtpUser || currentUser,
                        pass: smtpPass || emailConfig.imap?.auth?.pass || ''
                    }
                },
                from: fromEmail || `CCGram <${smtpUser || currentUser}>`,
                to: toEmail || currentTo
            }
        };
        
        // Save configuration
        this.config.setChannel('email', newEmailConfig);
        console.log('\n✅ Email configuration saved');
        
        // Ask whether to test
        const testChoice = await this.question('\nTest email sending? (y/n): ');
        if (testChoice.toLowerCase() === 'y') {
            await this.testEmailChannel();
        }
    }
    
    async testEmailChannel() {
        console.log('\n🧪 Testing email sending...');
        
        try {
            const EmailChannel = require('../channels/email/smtp');
            const emailConfig = this.config.getChannel('email');
            
            if (!emailConfig || !emailConfig.enabled) {
                console.log('❌ Email channel not enabled');
                return;
            }
            
            const emailChannel = new EmailChannel(emailConfig.config);
            const testResult = await emailChannel.test();
            
            if (testResult) {
                console.log('✅ Email sending test successful!');
                console.log('📧 Please check your inbox, you should receive a test email');
                console.log('💡 You can try replying to that email to test the command relay feature');
            } else {
                console.log('❌ Email sending test failed');
                console.log('Please check if your SMTP configuration is correct');
            }
        } catch (error) {
            console.log('❌ Email test failed:', error.message);
            console.log('Please check your network connection and email configuration');
        }
    }

    showHelp() {
        console.log(`
CCGram Configuration Manager

Usage: claude-remote config [options]

Options:
  --show    Show current configuration
  --help    Show help information

Interactive Commands:
  1. Basic Settings    - Language, enabled status, timeout, etc.
  2. Sound Configuration    - Configure task completion and waiting input sounds
  3. Notification Channels    - Configure email, Discord, Telegram and other notification channels
  4. Command Relay    - Configure remote command execution features
  5. Test Notifications    - Test all configured notification channels
        `);
    }
}

module.exports = ConfigurationManager;