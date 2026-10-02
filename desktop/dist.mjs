// Builds installers with electron-builder. If a self-signed certificate exists in .signing/
// (scripts/make-signing-cert.ps1), the Windows build is signed with it.
//   node dist.mjs --win | --mac | --linux
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const at = p => fileURLToPath(new URL(p, import.meta.url));
const env = { ...process.env };
const pfx = at('./.signing/site-status-codesign.pfx');
if (process.argv.includes('--win') && existsSync(pfx) && !env.CSC_LINK) {
  env.CSC_LINK = pfx;
  env.CSC_KEY_PASSWORD = readFileSync(at('./.signing/password.txt'), 'utf8').trim();
  console.log('Signing with self-signed certificate from .signing/');
}
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('node', ['sync.mjs']);
run('npx', ['electron-builder', ...process.argv.slice(2)]);
