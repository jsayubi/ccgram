/**
 * CCGram Installer
 * Handles installation and configuration of Claude Code hooks
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const Logger = require('../core/logger');

class Installer {
    constructor(configManager) {
        this.config = configManager;
        this.logger = new Logger('Installer');
        this.projectDir = path.join(__dirname, '../..');
        this.claudeConfigDir = this.getClaudeConfigDir();
        
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }

    getClaudeConfigDir() {
        const homeDir = os.homedir();
        
        // Common Claude Code configuration paths
        const possiblePaths = [
            path.join(homeDir, '.claude'),
            path.join(homeDir, '.config', 'claude'),
            path.join(homeDir, 'Library', 'Application Support', 'Claude'),
            path.join(homeDir, 'AppData', 'Roaming', 'Claude')
        ];

        for (const configPath of possiblePaths) {
            if (fs.existsSync(configPath)) {
                return configPath;
            }
        }

        // Default fallback
        return path.join(homeDir, '.claude');
    }

    async question(prompt) {
        return new Promise((resolve) => {
            this.rl.question(prompt, resolve);
        });
    }

    async run(args = []) {
        console.log('=== CCGram Claude Code Installer ===\n');

        // Check dependencies
        if (!this.checkDependencies()) {
            console.log('\nPlease install required dependencies first');
            this.rl.close();
            return;
        }

        console.log(`\nClaude Code configuration directory: ${this.claudeConfigDir}`);
        
        const proceed = await this.question('\nContinue with installation? (y/n): ');
        if (proceed.toLowerCase() !== 'y' && proceed.toLowerCase() !== 'yes') {
            console.log('Installation cancelled');
            this.rl.close();
            return;
        }

        // Install hooks
        const hookSuccess = await this.installHooks();
        if (!hookSuccess) {
            this.rl.close();
            return;
        }

        // Initialize configuration
        await this.initializeConfig();

        // Test installation
        const testChoice = await this.question('\nTest installation? (y/n): ');
        if (testChoice.toLowerCase() === 'y' || testChoice.toLowerCase() === 'yes') {
            await this.testInstallation();
        }

        this.displayUsage();
        this.rl.close();
    }

    checkDependencies() {
        console.log('Checking dependencies...');
        
        // Check Node.js
        try {
            const nodeVersion = process.version;
            console.log(`✅ Node.js ${nodeVersion}`);
        } catch (error) {
            console.log('❌ Node.js not installed');
            return false;
        }

        // Check platform-specific notification tools
        const platform = process.platform;
        switch (platform) {
            case 'darwin':
                console.log('✅ macOS notification support');
                break;
            case 'linux':
                console.log('ℹ️  Linux system, please ensure libnotify-bin is installed');
                break;
            case 'win32':
                console.log('✅ Windows notification support');
                break;
            default:
                console.log(`⚠️  Platform ${platform} may not be fully supported`);
        }

        return true;
    }

    createHooksConfig() {
        const claudeRemotePath = path.join(this.projectDir, 'claude-remote.js');
        
        return {
            hooks: {
                Stop: [
                    {
                        matcher: "*",
                        hooks: [
                            {
                                type: "command",
                                command: `node "${claudeRemotePath}" notify --type completed`,
                                timeout: 5
                            }
                        ]
                    }
                ],
                SubagentStop: [
                    {
                        matcher: "*",
                        hooks: [
                            {
                                type: "command", 
                                command: `node "${claudeRemotePath}" notify --type waiting`,
                                timeout: 5
                            }
                        ]
                    }
                ]
            }
        };
    }

    async installHooks() {
        console.log('\nInstalling Claude Code hooks...');
        
        // Create config directory if it doesn't exist
        if (!fs.existsSync(this.claudeConfigDir)) {
            fs.mkdirSync(this.claudeConfigDir, { recursive: true });
            console.log(`✅ Created configuration directory: ${this.claudeConfigDir}`);
        }

        const settingsPath = path.join(this.claudeConfigDir, 'settings.json');
        let settings = {};

        // Load existing settings
        if (fs.existsSync(settingsPath)) {
            try {
                const content = fs.readFileSync(settingsPath, 'utf8');
                settings = JSON.parse(content);
                console.log('✅ Loaded existing Claude Code settings');
            } catch (error) {
                console.log('⚠️  Unable to parse existing settings, will create new configuration');
            }
        }

        // Create or update hooks configuration
        const hooksConfig = this.createHooksConfig();
        
        // Merge with existing settings
        settings.hooks = {
            ...settings.hooks,
            ...hooksConfig.hooks
        };

        // Save updated settings
        try {
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
            console.log(`✅ Claude Code hooks installed to: ${settingsPath}`);
            return true;
        } catch (error) {
            console.error(`❌ Installation failed: ${error.message}`);
            return false;
        }
    }

    async initializeConfig() {
        console.log('\nInitializing configuration...');
        
        // Load and save default configuration
        this.config.load();
        this.config.save();
        
        console.log('✅ Configuration file initialized');
    }

    async testInstallation() {
        console.log('\nTesting installation...');
        
        try {
            const ClaudeCodeRemoteCLI = require('../../claude-remote');
            const cli = new ClaudeCodeRemoteCLI();
            await cli.init();
            
            console.log('Testing task completion notification...');
            await cli.handleNotify(['--type', 'completed']);
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            console.log('Testing waiting input notification...');
            await cli.handleNotify(['--type', 'waiting']);
            
            console.log('✅ Test successful!');
            return true;
        } catch (error) {
            console.error(`❌ Test failed: ${error.message}`);
            return false;
        }
    }

    displayUsage() {
        console.log('\n=== Installation Complete ===');
        console.log('');
        console.log('Now when you use Claude Code:');
        console.log('• You will receive notifications when tasks are completed');
        console.log('• You will receive reminders when Claude is waiting for input');
        console.log('');
        console.log('Common commands:');
        console.log(`  node "${path.join(this.projectDir, 'claude-remote.js')}" config`);
        console.log(`  node "${path.join(this.projectDir, 'claude-remote.js')}" test`);
        console.log(`  node "${path.join(this.projectDir, 'claude-remote.js')}" status`);
        console.log('');
        console.log('To uninstall, manually delete the hooks configuration from Claude Code settings.');
    }
}

module.exports = Installer;