// Creates a self-generated release keystore for the direct-download APK and writes
// android/keystore.properties. Both are gitignored: back them up, because every future update
// must be signed with the same key or Android will refuse to install it over the old version.
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidEnv } from './env.mjs';

const dir = fileURLToPath(new URL('./android/', import.meta.url));
const store = join(dir, 'site-status-release.jks');
if (existsSync(store)) { console.log('Keystore already exists:', store); process.exit(0); }

const env = androidEnv();
const password = randomBytes(24).toString('base64url');
const r = spawnSync(join(env.JAVA_HOME, 'bin', 'keytool'), [
  '-genkeypair', '-v', '-keystore', store, '-storetype', 'PKCS12',
  '-alias', 'site-status', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
  '-storepass', password, '-keypass', password,
  '-dname', 'CN=Site Status, O=Andrew Rigney',
], { stdio: 'inherit', env });
if (r.status !== 0) process.exit(r.status ?? 1);

writeFileSync(join(dir, 'keystore.properties'),
  `storeFile=site-status-release.jks\nstorePassword=${password}\nkeyAlias=site-status\nkeyPassword=${password}\n`);
console.log('Created', store, 'and android/keystore.properties');
