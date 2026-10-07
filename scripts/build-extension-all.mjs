// Builds the extension (dist/extension), then any local-only variants: if this clone has a
// .git/hooks/build-local-extensions hook, it's run with --force. The hook is optional and never
// part of the repository; without it this is the same as `npm run build:extension`.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
const HOOK = 'build-local-extensions';

run(process.execPath, [join(root, 'scripts', 'build-extension.mjs')]);

let hook = null;
try { hook = execFileSync('git', ['rev-parse', '--git-path', `hooks/${HOOK}`], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* not a git clone */ }
if (hook && existsSync(resolve(root, hook))) run('git', ['hook', 'run', '--allow-unknown-hook-name', HOOK, '--', '--force']);
