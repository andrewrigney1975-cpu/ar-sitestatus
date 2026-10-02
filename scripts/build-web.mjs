// Stamps the package version into the front-end and refreshes the service worker's precache list,
// then copies web/ to dist/web for the Electron and Capacitor builds. Run with: npm run build:web
import { readFile, writeFile, readdir, rm, cp } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'web');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(p));
    else out.push(relative(web, p).split(sep).join('/'));
  }
  return out;
}

// 1. version.js
await writeFile(join(web, 'js/version.js'), `export const VERSION = '${version}';\n`);

// 2. sw.js: cache name + shell list
const files = (await walk(web)).filter(f => f !== 'sw.js').sort();
const shell = files.map(f => `  '${f === 'index.html' ? './' : './' + f}',`).join('\n');
let sw = await readFile(join(web, 'sw.js'), 'utf8');
sw = sw.replace(/const CACHE = '[^']*';/, `const CACHE = 'site-status-${version}';`)
  .replace(/( *)\/\* shell:start \*\/[\s\S]*?\/\* shell:end \*\//, `$1/* shell:start */\n${shell}\n$1/* shell:end */`);
await writeFile(join(web, 'sw.js'), sw);
console.log(`Stamped v${version}; precaching ${files.length} files`);

// 3. dist/web
if (!process.argv.includes('--no-copy')) {
  await rm(join(root, 'dist/web'), { recursive: true, force: true });
  await cp(web, join(root, 'dist/web'), { recursive: true });
  console.log('Copied web/ -> dist/web');
}
