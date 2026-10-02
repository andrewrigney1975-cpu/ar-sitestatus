// Copies the shared front-end into www/ (Capacitor's webDir; gitignored).
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const at = p => fileURLToPath(new URL(p, import.meta.url));
await rm(at('./www'), { recursive: true, force: true });
await cp(at('../web'), at('./www'), { recursive: true });
console.log('Synced web/ into mobile/www');
