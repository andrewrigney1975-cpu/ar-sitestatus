// Saving and opening JSON files, per platform:
//   Electron  -> native save/open dialogs via the preload bridge
//   Android   -> @capacitor/filesystem + @capacitor/share (WebView can't download Blobs)
//   Web       -> Blob download / <input type="file">

const cap = () => window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins : null;

export async function saveJson(filename, data) {
  const text = JSON.stringify(data, null, 2);

  if (window.siteStatusNative?.saveFile) {
    return window.siteStatusNative.saveFile(filename, text);          // resolves false if cancelled
  }

  const plugins = cap();
  if (plugins?.Filesystem && plugins?.Share) {
    const { uri } = await plugins.Filesystem.writeFile({ path: filename, data: text, directory: 'CACHE', encoding: 'utf8' });
    await plugins.Share.share({ title: 'Site Status sites', url: uri, dialogTitle: 'Save or share sites' });
    return true;
  }

  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Opens a JSON file and resolves with its text, or null when cancelled. */
export async function openJson(input) {
  if (window.siteStatusNative?.openFile) return window.siteStatusNative.openFile();
  return new Promise(resolve => {
    input.value = '';
    input.onchange = async () => resolve(input.files[0] ? await input.files[0].text() : null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}
