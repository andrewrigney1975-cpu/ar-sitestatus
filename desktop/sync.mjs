// Copies the shared front-end and probe engine into the Electron app folder (both gitignored here).
import { cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const at = p => fileURLToPath(new URL(p, import.meta.url));
for (const dir of ['web', 'shared']) {
  await rm(at(`./${dir}`), { recursive: true, force: true });
  await cp(at(`../${dir}`), at(`./${dir}`), { recursive: true });
}
console.log('Synced web/ and shared/ into desktop/');
