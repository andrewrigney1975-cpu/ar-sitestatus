// Builds the signed release APK for direct download: mobile/out/site-status-<version>.apk
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { androidEnv } from './env.mjs';

const at = p => fileURLToPath(new URL(p, import.meta.url));
const env = androidEnv();
const { version } = JSON.parse(readFileSync(at('./package.json'), 'utf8'));
const run = (cmd, args, cwd = at('.')) => {
  const quoted = process.platform === 'win32' && cmd.includes(' ') ? `"${cmd}"` : cmd;
  const r = spawnSync(quoted, args, { stdio: 'inherit', env, cwd, shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run('node', ['make-keystore.mjs']);
run('node', ['sync.mjs']);
run('npx', ['cap', 'sync', 'android']);
run(at(process.platform === 'win32' ? './android/gradlew.bat' : './android/gradlew'), ['assembleRelease', '--console=plain', '-q'], at('./android'));
mkdirSync(at('./out'), { recursive: true });
const dest = at(`./out/site-status-${version}.apk`);
copyFileSync(at('./android/app/build/outputs/apk/release/app-release.apk'), dest);
console.log('APK:', dest);
