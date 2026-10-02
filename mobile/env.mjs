// Locates the JDK (Android Studio's bundled JBR) and Android SDK when they aren't on the environment.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function androidEnv() {
  const env = { ...process.env };
  if (!env.JAVA_HOME) {
    const candidates = [
      'F:/Program Files/Android/Android Studio/jbr',
      'C:/Program Files/Android/Android Studio/jbr',
      '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
      '/opt/android-studio/jbr',
    ];
    env.JAVA_HOME = candidates.find(p => existsSync(p));
  }
  if (!env.ANDROID_HOME) {
    const candidates = [
      env.ANDROID_SDK_ROOT,
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Android', 'Sdk'),
      env.HOME && join(env.HOME, 'Android', 'Sdk'),
      env.HOME && join(env.HOME, 'Library', 'Android', 'sdk'),
    ].filter(Boolean);
    env.ANDROID_HOME = candidates.find(p => existsSync(p));
  }
  if (!env.JAVA_HOME) throw new Error('JDK not found: set JAVA_HOME (Android Studio ships one in its jbr/ folder).');
  if (!env.ANDROID_HOME) throw new Error('Android SDK not found: set ANDROID_HOME.');
  env.PATH = `${join(env.JAVA_HOME, 'bin')}${process.platform === 'win32' ? ';' : ':'}${env.PATH}`;
  return env;
}
