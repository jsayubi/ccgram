import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Project root directory — walks up from __dirname to find package.json.
 * Works from any depth in dist/ after TypeScript compilation.
 */
export const PROJECT_ROOT: string = (() => {
  let dir = __dirname;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
})();

/**
 * Persistent install directory for ccgram.
 * `ccgram init` copies the package here so hook paths survive npx cleanup.
 */
export const CCGRAM_HOME: string = path.join(os.homedir(), '.ccgram');
