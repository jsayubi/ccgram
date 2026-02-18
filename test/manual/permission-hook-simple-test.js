#!/usr/bin/env node
// Simple test: read stdin, immediately allow, exit
let data = '';
let done = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', () => { respond(); });
setTimeout(() => { respond(); }, 300);

function respond() {
  if (done) return;
  done = true;
  process.stdin.destroy();
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' },
    },
  }) + '\n');
}
