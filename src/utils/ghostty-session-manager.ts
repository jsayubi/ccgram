/**
 * Ghostty Session Manager — controls Ghostty terminal sessions via AppleScript.
 *
 * Ghostty 1.3.0+ supports native AppleScript for controlling terminal windows,
 * tabs, and splits. This backend is used when TERM_PROGRAM=ghostty and no
 * tmux session is available.
 *
 * Session identity: CWD-based. Stores Map<sessionName, cwd> as handles.
 * Text injection: input text "..." to terminal (paste-style, handles ANSI).
 * Key sequences: arrow keys via ANSI (send key "down" is broken in 1.3.0).
 * Modifier keys (C-c, C-u): use "send key KEY modifiers MOD to term" (no "with").
 */

import os from 'os';
import fs from 'fs';
import { exec, execSync } from 'child_process';

// Key name → macOS key code (sent via System Events after focus, bypasses bracketed paste)
// send key "down" is unsupported in Ghostty AppleScript; input text ANSI is wrapped in
// bracketed paste which Claude Code's TUI doesn't recognise as navigation.
const KEY_CODES: Record<string, number> = {
  'Down':  125,
  'Up':    126,
  'Space': 49,
};

// Keys sent via "send key NAME to term" (no modifiers)
const SEND_KEYS: Record<string, string> = {
  'Enter': 'enter',
  'C-m':   'enter',
};

// Keys using "send key KEY modifiers MOD to term" (no "with" — plain param per Ghostty sdef)
const MODIFIER_KEYS: Record<string, { key: string; modifiers: string }> = {
  'C-c': { key: 'c', modifiers: 'control' },
  'C-u': { key: 'u', modifiers: 'control' },
};

export class GhosttySessionManager {
  /** Map from session name to registered CWD. */
  private handles: Map<string, string> = new Map();

  /**
   * Whether Ghostty is available and running on this machine.
   * Re-checked each call (fast) so the bot handles Ghostty launching after startup.
   */
  isAvailable(): boolean {
    if (process.platform !== 'darwin') return false;
    try {
      const result = execSync('osascript -e "application \\"Ghostty\\" is running"', {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 2000,
      }).trim();
      return result === 'true';
    } catch {
      return false;
    }
  }

  /** Whether a handle is registered for this session name. */
  has(name: string): boolean {
    return this.handles.has(name);
  }

  /** Register (or update) a session handle with its CWD. */
  register(name: string, cwd: string): void {
    this.handles.set(name, cwd);
  }

  /** Remove a session handle. */
  unregister(name: string): void {
    this.handles.delete(name);
  }

  /**
   * Execute an AppleScript via osascript stdin pipe.
   * Using stdin pipe avoids all shell-quoting issues and supports multi-line scripts.
   */
  private runScript(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = exec('osascript -', { timeout: 5000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      });
      child.stdin!.write(script);
      child.stdin!.end();
    });
  }

  /**
   * Build an AppleScript string literal expression for the given value.
   * Handles embedded double-quotes via & quote & concatenation.
   */
  private buildAppleScriptString(str: string): string {
    const parts = str.split('"');
    return parts.map(p => `"${p}"`).join(' & quote & ');
  }

  /**
   * Build an AppleScript expression that produces the given text when evaluated.
   * Uses (character id N) for control characters/non-printable bytes,
   * and quote for embedded double-quotes.
   */
  private buildAppleScriptText(text: string): string {
    const parts: string[] = [];
    let current = '';

    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 32 && code < 127 && code !== 34) {
        // Printable ASCII except " — include in string literal
        current += text[i];
      } else if (code === 34) { // "
        if (current) { parts.push(`"${current}"`); current = ''; }
        parts.push('quote');
      } else {
        // Control character or non-ASCII — use character id
        if (current) { parts.push(`"${current}"`); current = ''; }
        parts.push(`(character id ${code})`);
      }
    }

    if (current) parts.push(`"${current}"`);
    if (parts.length === 0) return '""';
    return parts.join(' & ');
  }

  /**
   * Build the AppleScript fragment that finds the terminal for a registered CWD.
   * Iterates all windows and tabs to find the terminal whose working directory matches.
   */
  private findTermScript(cwd: string): string {
    const cwdExpr = this.buildAppleScriptString(cwd);
    return `set targetCwd to ${cwdExpr}
set foundTerm to missing value
tell application "Ghostty"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with term in terminals of t
        if working directory of term is targetCwd then
          set foundTerm to term
          exit repeat
        end if
      end repeat
      if foundTerm is not missing value then exit repeat
    end repeat
    if foundTerm is not missing value then exit repeat
  end repeat
  if foundTerm is missing value then error "No Ghostty terminal found for cwd: " & targetCwd
end tell`;
  }

  /**
   * Write raw text to a Ghostty terminal (paste-style).
   * Handles printable ASCII, control characters (e.g. \r for Enter),
   * and ANSI escape sequences (e.g. \x1B[B for Down arrow).
   */
  async write(name: string, text: string): Promise<boolean> {
    const cwd = this.handles.get(name);
    if (!cwd) return false;

    try {
      const textExpr = this.buildAppleScriptText(text);
      const script = `${this.findTermScript(cwd)}
tell application "Ghostty"
  input text ${textExpr} to foundTerm
end tell`;
      await this.runScript(script);
      return true;
    } catch (err: unknown) {
      process.stderr.write(`[ghostty-session-manager] write failed for ${name}: ${(err as Error).message}\n`);
      return false;
    }
  }

  /**
   * Write text then immediately press Return — all in one AppleScript execution.
   * Avoids a second CWD lookup between write and Enter, which can miss the terminal.
   */
  async writeLine(name: string, text: string): Promise<boolean> {
    const cwd = this.handles.get(name);
    if (!cwd) return false;

    try {
      const textExpr = this.buildAppleScriptText(text);
      const script = `${this.findTermScript(cwd)}
tell application "Ghostty"
  focus foundTerm
  input text ${textExpr} to foundTerm
  delay 0.1
  send key "enter" to foundTerm
end tell`;
      await this.runScript(script);
      return true;
    } catch (err: unknown) {
      process.stderr.write(`[ghostty-session-manager] writeLine failed for ${name}: ${(err as Error).message}\n`);
      return false;
    }
  }

  /**
   * Send a named key to a session.
   * C-c and C-u use "send key ... with modifiers" (required by Ghostty AppleScript).
   * Down, Up, Enter, Space use ANSI sequences via input text
   * (send key "down" is broken in Ghostty 1.3.0).
   */
  async sendKey(name: string, key: string): Promise<boolean> {
    const cwd = this.handles.get(name);
    if (!cwd) return false;

    const modKey = MODIFIER_KEYS[key];
    if (modKey) {
      try {
        const script = `${this.findTermScript(cwd)}
tell application "Ghostty"
  focus foundTerm
  send key "${modKey.key}" modifiers "${modKey.modifiers}" to foundTerm
end tell`;
        await this.runScript(script);
        return true;
      } catch (err: unknown) {
        process.stderr.write(`[ghostty-session-manager] sendKey(${key}) failed for ${name}: ${(err as Error).message}\n`);
        return false;
      }
    }

    const sendKeyName = SEND_KEYS[key];
    if (sendKeyName) {
      try {
        const script = `${this.findTermScript(cwd)}
tell application "Ghostty"
  focus foundTerm
  send key "${sendKeyName}" to foundTerm
end tell`;
        await this.runScript(script);
        return true;
      } catch (err: unknown) {
        process.stderr.write(`[ghostty-session-manager] sendKey(${key}) failed for ${name}: ${(err as Error).message}\n`);
        return false;
      }
    }

    const keyCode = KEY_CODES[key];
    if (keyCode !== undefined) {
      try {
        const script = `${this.findTermScript(cwd)}
tell application "Ghostty"
  focus foundTerm
end tell
tell application "System Events"
  tell process "Ghostty"
    key code ${keyCode}
  end tell
end tell`;
        await this.runScript(script);
        return true;
      } catch (err: unknown) {
        process.stderr.write(`[ghostty-session-manager] sendKey(${key}) failed for ${name}: ${(err as Error).message}\n`);
        return false;
      }
    }

    // Unknown key — pass through as text
    return this.write(name, key);
  }

  /** Send Ctrl+C interrupt to the terminal. */
  async interrupt(name: string): Promise<boolean> {
    return this.sendKey(name, 'C-c');
  }

  /**
   * Capture terminal scrollback by triggering write_scrollback_file.
   * Finds the new file in the OS temp directory and reads its content.
   * Returns null if unavailable or no file produced within 1s.
   */
  async capture(name: string): Promise<string | null> {
    const cwd = this.handles.get(name);
    if (!cwd) return null;

    const tmpDir = os.tmpdir();

    // 1. Note existing Ghostty temp files and their mtimes
    const existingFiles = new Map<string, number>();
    try {
      const files = fs.readdirSync(tmpDir);
      for (const f of files) {
        const fl = f.toLowerCase();
        if (fl.startsWith('ghostty') || fl.startsWith('com.mitchellh.ghostty')) {
          try {
            const mtime = fs.statSync(`${tmpDir}/${f}`).mtimeMs;
            existingFiles.set(f, mtime);
          } catch {}
        }
      }
    } catch {}

    // 2. Trigger write_scrollback_file
    try {
      const script = `${this.findTermScript(cwd)}
tell application "Ghostty"
  perform action "write_scrollback_file" on foundTerm
end tell`;
      await this.runScript(script);
    } catch (err: unknown) {
      process.stderr.write(`[ghostty-session-manager] capture trigger failed for ${name}: ${(err as Error).message}\n`);
      return null;
    }

    // 3. Wait up to 1s for a new (or updated) file to appear
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      try {
        const files = fs.readdirSync(tmpDir);
        for (const f of files) {
          const fl = f.toLowerCase();
          if (fl.startsWith('ghostty') || fl.startsWith('com.mitchellh.ghostty')) {
            const filePath = `${tmpDir}/${f}`;
            try {
              const mtime = fs.statSync(filePath).mtimeMs;
              const prevMtime = existingFiles.get(f);
              if (prevMtime === undefined || mtime > prevMtime) {
                return fs.readFileSync(filePath, 'utf8');
              }
            } catch {}
          }
        }
      } catch {}
      await new Promise<void>(r => setTimeout(r, 100));
    }

    return null;
  }

  /**
   * Open a new tab in the front Ghostty window and run a command.
   * Uses AppleScript's quoted form of for safe shell quoting of the cwd.
   */
  async openNewTab(cwd: string, command: string): Promise<boolean> {
    try {
      // Build AppleScript expression for cwd (used with quoted form of)
      const cwdExpr = this.buildAppleScriptString(cwd);
      // Build AppleScript expression for the command (plain text)
      const cmdExpr = this.buildAppleScriptText(command);
      const script = `tell application "Ghostty"
  if (count of windows) is 0 then error "No Ghostty windows open"
  set w to front window
  perform action "new_tab" on w
  delay 0.5
  set term to focused terminal of selected tab of w
  focus term
  input text "cd " & quoted form of ${cwdExpr} & " && " & ${cmdExpr} to term
  delay 0.1
  send key "enter" to term
end tell`;
      await this.runScript(script);
      return true;
    } catch (err: unknown) {
      process.stderr.write(`[ghostty-session-manager] openNewTab failed: ${(err as Error).message}\n`);
      return false;
    }
  }
}

export const ghosttySessionManager = new GhosttySessionManager();
