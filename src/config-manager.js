const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Logger = require('./core/logger');
const logger = new Logger('ConfigManager');

class ConfigManager {
  constructor() {
    this.configPath = path.join(__dirname, '../config/channels.json');
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }

  async loadConfig() {
    try {
      const data = fs.readFileSync(this.configPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      logger.error('Failed to load config:', error);
      throw error;
    }
  }

  async saveConfig(config) {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      logger.info('Configuration saved successfully');
    } catch (error) {
      logger.error('Failed to save config:', error);
      throw error;
    }
  }

  async question(prompt) {
    return new Promise((resolve) => {
      this.rl.question(prompt, resolve);
    });
  }

  async configureEmail() {
    console.log('\n📧 Email Configuration Setup\n');
    
    const config = await this.loadConfig();
    
    console.log('Please enter your email configuration:');
    console.log('(Press Enter to keep current value)\n');

    // SMTP Configuration
    console.log('--- SMTP Settings (for sending emails) ---');
    const smtpHost = await this.question(`SMTP Host [${config.email.config.smtp.host || 'smtp.gmail.com'}]: `);
    config.email.config.smtp.host = smtpHost || config.email.config.smtp.host || 'smtp.gmail.com';

    const smtpPort = await this.question(`SMTP Port [${config.email.config.smtp.port || 587}]: `);
    config.email.config.smtp.port = parseInt(smtpPort) || config.email.config.smtp.port || 587;

    const smtpUser = await this.question(`Email Address [${config.email.config.smtp.auth.user || ''}]: `);
    config.email.config.smtp.auth.user = smtpUser || config.email.config.smtp.auth.user;

    const smtpPass = await this.question(`App Password [${config.email.config.smtp.auth.pass ? '***' : ''}]: `);
    if (smtpPass) {
      config.email.config.smtp.auth.pass = smtpPass;
    }

    // IMAP Configuration
    console.log('\n--- IMAP Settings (for receiving emails) ---');
    const imapHost = await this.question(`IMAP Host [${config.email.config.imap.host || 'imap.gmail.com'}]: `);
    config.email.config.imap.host = imapHost || config.email.config.imap.host || 'imap.gmail.com';

    const imapPort = await this.question(`IMAP Port [${config.email.config.imap.port || 993}]: `);
    config.email.config.imap.port = parseInt(imapPort) || config.email.config.imap.port || 993;

    // Use same credentials as SMTP by default
    config.email.config.imap.auth.user = config.email.config.smtp.auth.user;
    config.email.config.imap.auth.pass = config.email.config.smtp.auth.pass;

    // Email addresses
    console.log('\n--- Email Addresses ---');
    const fromEmail = await this.question(`From Address [${config.email.config.from || `CCGram <${config.email.config.smtp.auth.user}>`}]: `);
    config.email.config.from = fromEmail || config.email.config.from || `CCGram <${config.email.config.smtp.auth.user}>`;

    const toEmail = await this.question(`To Address [${config.email.config.to || config.email.config.smtp.auth.user}]: `);
    config.email.config.to = toEmail || config.email.config.to || config.email.config.smtp.auth.user;

    // Enable email
    const enable = await this.question('\nEnable email notifications? (y/n) [y]: ');
    config.email.enabled = enable.toLowerCase() !== 'n';

    await this.saveConfig(config);
    console.log('\n✅ Email configuration completed!');
    
    if (config.email.enabled) {
      console.log('\n📌 Important: Make sure to use an App Password (not your regular password)');
      console.log('   Gmail: https://support.google.com/accounts/answer/185833');
      console.log('   Outlook: https://support.microsoft.com/en-us/account-billing/using-app-passwords-with-apps-that-don-t-support-two-step-verification-5896ed9b-4263-e681-128a-a6f2979a7944');
    }
  }

  async showCurrentConfig() {
    const config = await this.loadConfig();
    console.log('\n📋 Current Configuration:\n');
    
    for (const [channel, settings] of Object.entries(config)) {
      console.log(`${channel}:`);
      console.log(`  Enabled: ${settings.enabled ? '✅' : '❌'}`);
      
      if (channel === 'email' && settings.config.smtp.auth.user) {
        console.log(`  Email: ${settings.config.smtp.auth.user}`);
        console.log(`  SMTP: ${settings.config.smtp.host}:${settings.config.smtp.port}`);
        console.log(`  IMAP: ${settings.config.imap.host}:${settings.config.imap.port}`);
      }
      console.log();
    }
  }

  async toggleChannel(channelName) {
    const config = await this.loadConfig();
    
    if (!config[channelName]) {
      console.log(`❌ Channel "${channelName}" not found`);
      return;
    }

    config[channelName].enabled = !config[channelName].enabled;
    await this.saveConfig(config);
    
    console.log(`${channelName}: ${config[channelName].enabled ? '✅ Enabled' : '❌ Disabled'}`);
  }

  async interactiveMenu() {
    console.log('\n🛠️  CCGram Configuration Manager\n');
    
    while (true) {
      console.log('\nChoose an option:');
      console.log('1. Configure Email');
      console.log('2. Show Current Configuration');
      console.log('3. Toggle Channel (enable/disable)');
      console.log('4. Exit');
      
      const choice = await this.question('\nYour choice (1-4): ');
      
      switch (choice) {
        case '1':
          await this.configureEmail();
          break;
        case '2':
          await this.showCurrentConfig();
          break;
        case '3':
          const channel = await this.question('Channel name (desktop/email/discord/telegram/whatsapp/feishu): ');
          await this.toggleChannel(channel);
          break;
        case '4':
          console.log('\n👋 Goodbye!');
          this.rl.close();
          return;
        default:
          console.log('Invalid choice. Please try again.');
      }
    }
  }

  close() {
    this.rl.close();
  }
}

// Run as standalone script
if (require.main === module) {
  const manager = new ConfigManager();
  manager.interactiveMenu().catch(console.error);
}

module.exports = ConfigManager;