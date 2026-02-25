/**
 * PTY Session Manager — manages headless node-pty sessions for tmux-less operation.
 *
 * When tmux is unavailable, /new spawns Claude via node-pty instead of tmux.
 * CCGram owns the PTY master, so all Telegram features (permissions, questions,
 * commands, /status, /stop) work without tmux. Sessions are not attachable from
 * a terminal.
 *
 * Uses optionalRequire so the bot starts normally even when node-pty is not installed.
 */

import path from 'path';
import fs from 'fs';
import { optionalRequire } from './optional-require';
import { CCGRAM_HOME } from './paths';

// Key name → raw escape sequence (mirrors tmux key names used throughout the bot)
const KEY_SEQUENCES: Record<string, string> = {
  'Down':  '\x1B[B',
  'Up':    '\x1B[A',
  'Enter': '\r',
  'C-m':   '\r',
  'C-c':   '\x03',
  'C-u':   '\x15',
  'Space': ' ',
};

// Minimal node-pty IPty interface (subset we need)
interface IPty {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(file: string, args: string[], options: Record<string, unknown>): IPty;
}

/**
 * Strip ANSI escape sequences from terminal output for clean line buffering.
 */
function stripAnsi(str: string): string {
  return str
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')     // CSI sequences (colors, cursor)
    .replace(/\x1B\][^\x07]*\x07/g, '')          // OSC sequences (window title)
    .replace(/\x1B[()][AB012]/g, '')             // character set
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, ''); // control chars
}

export class PtySessionManager {
  private ptyModule: NodePtyModule | null;
  private handles: Map<string, IPty> = new Map();
  private buffers: Map<string, string[]> = new Map();

  constructor() {
    this.ptyModule = optionalRequire('node-pty', 'PTY sessions') as NodePtyModule | null;
  }

  /** Whether node-pty is loadable on this machine. */
  isAvailable(): boolean {
    return this.ptyModule !== null;
  }

  /** Whether a live PTY handle exists for this session name. */
  has(sessionName: string): boolean {
    return this.handles.has(sessionName);
  }

  /**
   * Spawn a new headless PTY session running the claude CLI.
   * @param args  Optional CLI args passed to claude (e.g. ['--resume', '<id>'])
   * @returns true on success, false on failure
   */
  spawn(name: string, cwd: string, args: string[] = []): boolean {
    if (!this.ptyModule) return false;

    // Kill any existing handle for this name to avoid orphaned processes
    if (this.handles.has(name)) {
      this.kill(name);
    }

    try {
      const claudePath = process.env.CLAUDE_CLI_PATH || 'claude';
      const pty = this.ptyModule.spawn(claudePath, args, {
        name: 'xterm-256color',
        cols: 220,
        rows: 50,
        cwd,
        env: { ...process.env },
      });

      this.handles.set(name, pty);
      this.buffers.set(name, []);

      // Ensure logs directory exists
      const logsDir = path.join(CCGRAM_HOME, 'logs');
      try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
      const logFile = path.join(logsDir, `pty-${name}.log`);

      pty.onData((data: string) => {
        // Append raw data to session log
        try { fs.appendFileSync(logFile, data); } catch {}

        // Strip ANSI and buffer as lines
        const clean = stripAnsi(data);
        const parts = clean.split(/\r?\n/);
        const buf = this.buffers.get(name) || [];

        for (let i = 0; i < parts.length; i++) {
          if (i === 0) {
            // First part continues the last buffered (partial) line
            if (buf.length === 0) {
              buf.push(parts[0]);
            } else {
              buf[buf.length - 1] += parts[0];
            }
          } else {
            buf.push(parts[i]);
          }
        }

        // Keep last 100 lines
        if (buf.length > 100) {
          buf.splice(0, buf.length - 100);
        }
        this.buffers.set(name, buf);
      });

      pty.onExit(() => {
        this.handles.delete(name);
        this.buffers.delete(name);
      });

      return true;
    } catch (err: unknown) {
      process.stderr.write(`[pty-session-manager] Failed to spawn ${name}: ${(err as Error).message}\n`);
      return false;
    }
  }

  /** Write raw bytes directly to the PTY master fd. */
  write(name: string, data: string): boolean {
    const pty = this.handles.get(name);
    if (!pty) return false;
    try {
      pty.write(data);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Translate a tmux-style key name to its escape sequence and write to PTY.
   * Supported: Down, Up, Enter, C-m, C-c, C-u, Space.
   */
  sendKey(name: string, key: string): boolean {
    const seq = KEY_SEQUENCES[key];
    if (seq === undefined) {
      // Unknown key — pass through as-is (shouldn't happen in normal usage)
      return this.write(name, key);
    }
    return this.write(name, seq);
  }

  /**
   * Return the last N lines of buffered output, or null if session unknown.
   */
  capture(name: string, lines: number = 100): string | null {
    const buf = this.buffers.get(name);
    if (!buf) return null;
    return buf.slice(-lines).join('\n');
  }

  /** Send Ctrl+C interrupt to the session. */
  interrupt(name: string): boolean {
    return this.write(name, '\x03');
  }

  /** Kill the PTY process and remove from tracking maps. */
  kill(name: string): boolean {
    const pty = this.handles.get(name);
    if (!pty) return false;
    try {
      pty.kill();
      this.handles.delete(name);
      this.buffers.delete(name);
      return true;
    } catch {
      return false;
    }
  }
}

export const ptySessionManager = new PtySessionManager();
