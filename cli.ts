#!/usr/bin/env node

'use strict';

import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT, CCGRAM_HOME } from './src/utils/paths';

const [,, cmd, ...args] = process.argv;

const HOOK_DEFINITIONS = [
  { event: 'PermissionRequest', script: 'permission-hook.js', timeout: 120, matcher: undefined as string | undefined, args: undefined as string | undefined },
  { event: 'PreToolUse', script: 'question-notify.js', timeout: 5, matcher: 'AskUserQuestion', args: undefined as string | undefined },
  { event: 'Stop', script: 'enhanced-hook-notify.js', args: 'completed', timeout: 5, matcher: undefined as string | undefined },
  { event: 'Notification', script: 'enhanced-hook-notify.js', args: 'waiting', timeout: 5, matcher: 'permission_prompt' },
];

/**
 * Resolve the dist/ directory to use for runtime commands.
 * Prefers ~/.ccgram/dist/ if it exists (persistent install), falls back to __dirname.
 */
function resolveDistDir(): string {
  const homeDistDir = path.join(CCGRAM_HOME, 'dist');
  if (fs.existsSync(path.join(homeDistDir, 'workspace-telegram-bot.js'))) {
    return homeDistDir;
  }
  return __dirname;
}

/**
 * Resolve the project root for data paths.
 * Prefers ~/.ccgram/ if it has been initialized, falls back to PROJECT_ROOT.
 */
function resolveDataRoot(): string {
  if (fs.existsSync(path.join(CCGRAM_HOME, 'package.json'))) {
    return CCGRAM_HOME;
  }
  return PROJECT_ROOT;
}

switch (cmd) {
  case 'init':
  case 'setup':
    // Always use current package for init — ensures updates propagate to ~/.ccgram/
    spawn(process.execPath, [path.join(__dirname, 'setup.js')], { stdio: 'inherit' })
      .on('exit', (code) => process.exit(code ?? 0));
    break;

  case 'start': {
    const distDir = resolveDistDir();
    const botScript = path.join(distDir, 'workspace-telegram-bot.js');
    if (!fs.existsSync(botScript)) {
      console.error('Error: ccgram is not installed. Run `ccgram init` first.');
      process.exit(1);
    }
    spawn(process.execPath, [botScript], { stdio: 'inherit' })
      .on('exit', (code) => process.exit(code ?? 0));
    break;
  }

  case 'hooks': {
    const distDir = resolveDistDir();
    const hooks: Record<string, Array<Record<string, unknown>>> = {};
    for (const def of HOOK_DEFINITIONS) {
      const scriptPath = path.join(distDir, def.script);
      const command = `node ${scriptPath}${def.args ? ' ' + def.args : ''}`;
      const hook = { type: 'command', command, timeout: def.timeout };
      const entry: Record<string, unknown> = { hooks: [hook] };
      if (def.matcher) entry.matcher = def.matcher;
      hooks[def.event] = hooks[def.event] || [];
      hooks[def.event].push(entry);
    }
    console.log('\nAdd this to ~/.claude/settings.json under "hooks":');
    console.log(JSON.stringify(hooks, null, 2));
    break;
  }

  case 'status': {
    const dataRoot = resolveDataRoot();
    const sessionMapPath = path.join(dataRoot, 'src/data/session-map.json');
    let sessions: Record<string, unknown> = {};
    try { sessions = JSON.parse(fs.readFileSync(sessionMapPath, 'utf8')); } catch {}
    const sessionCount = Object.keys(sessions).length;
    let botRunning = false;
    try { execSync('pgrep -f workspace-telegram-bot.js', { stdio: 'ignore' }); botRunning = true; } catch {}
    console.log(`Bot:      ${botRunning ? 'running' : 'stopped'}`);
    console.log(`Sessions: ${sessionCount}`);
    if (process.env.HEALTH_PORT) {
      console.log(`Health:   http://127.0.0.1:${process.env.HEALTH_PORT}/health`);
    }
    break;
  }

  default:
    console.log('ccgram — Control Claude Code from Telegram\n');
    console.log('Usage: ccgram <command>\n');
    console.log('Commands:');
    console.log('  init      Run interactive setup (configure .env and Claude hooks)');
    console.log('  start     Start the Telegram bot');
    console.log('  hooks     Print Claude hooks JSON for copy-paste');
    console.log('  status    Show bot and session status');
    if (cmd && cmd !== '--help' && cmd !== '-h') {
      console.error(`\nUnknown command: ${cmd}`);
      process.exit(1);
    }
    break;
}
