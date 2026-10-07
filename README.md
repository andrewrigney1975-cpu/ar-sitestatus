# Site Status

A lightweight heartbeat monitor. Add sites by name and URL and it checks them on a fixed interval, showing up/down, HTTP status and response time as a status-page style history. Hover any bar for the details of that check.

One vanilla HTML/JS/CSS front end ships as:

- a **PWA** served by a small Node API in Docker
- a **desktop app** (Electron) for Windows, macOS and Debian/Ubuntu
- an **Android app** (Capacitor)
- a **browser sidebar extension** for Chrome, Edge and Firefox, which needs no server

## How checks are made

| Where it runs | Checked by | Sees HTTP status? |
|---|---|---|
| Desktop app | Node probe engine in the Electron main process | ✅ plus DNS / connect / TLS / TTFB timings |
| Android app | Native HTTP (`CapacitorHttp`) | ✅ |
| Browser / PWA | The API server (`api/server.mjs`) | ✅ plus timings |
| Sidebar extension | `fetch` from the extension, with host permission | ✅ plus server IP and approximate time to first byte |
| Browser, API unreachable | The browser itself (`fetch` in `no-cors` mode) | ❌ CORS hides it, so a site shows only as reachable or unreachable |

When the API stops answering, the web app switches to browser checks automatically. It checks the API's health every 5 minutes and switches back when the API returns. The header badge always shows which mode is active.

## Quick start (Docker)

```sh
docker compose up -d        # http://localhost:8080
```

`localhost` counts as a secure origin, so you can install the PWA from there (use the **Install** button, or the browser menu).

Configuration is in [`compose.yaml`](compose.yaml):

| Variable | Default | Purpose |
|---|---|---|
| `ALLOW_PRIVATE` | `true` in compose, `false` otherwise | Allow checks of LAN / private addresses. Set to `false` if the port is reachable from other machines. |
| `CORS_ORIGINS` | *(same origin only)* | Extra origins allowed to call the API. Calls from any other origin get a 403. |
| `RATE_LIMIT_PER_MIN` | `1200` | URLs checked per client IP per minute |
| `ALLOWED_PORTS` | `*` | Port allow-list, e.g. `80,443,8000-9000` |

The container reaches services running on the Docker host at `http://host.docker.internal:PORT`. Inside the container, `localhost` means the container itself.

## Development

Requires Node 24+.

```sh
npm install            # sharp, used only by the asset generator
npm start              # API + PWA on http://localhost:8080 (no Docker)
npm test               # unit tests (node:test, no dependencies)
npm run assets         # regenerate icons and splash screens from the SVG masters
npm run fonts          # re-download Google Sans into web/fonts
npm run build:web      # stamp the version and refresh the service worker's precache list
```

The service worker serves cached files first. While editing `web/`, either tick *Update on reload* in DevTools → Application, or run `npm run build:web` so the cache version changes.

## Desktop (Electron)

```sh
cd desktop
npm install
npm start              # run from source
npm run dist:win       # NSIS installers (x64 and arm64), signed if desktop/.signing/ exists
npm run dist:linux     # .deb packages (amd64 and arm64); must run on Linux, see below
npm run dist:mac       # universal DMG; must run on macOS
```

- **Windows signing** uses a self-signed certificate. Create it once with `powershell -File scripts/make-signing-cert.ps1`. It writes `desktop/.signing/`, which is gitignored. Windows SmartScreen still warns, because the certificate isn't from a trusted CA.
- **Building `.deb` on Windows**: run the build inside electron-builder's image:
  ```sh
  docker run --rm -v "$PWD/desktop:/project" -w /project electronuserland/builder:20 \
    node node_modules/electron-builder/cli.js --linux
  ```
- **macOS**: the build is ad-hoc signed and not notarized. On first launch, right-click the app and choose Open, then confirm.
- `SITESTATUS_SMOKE=1 npx electron .` starts the app, adds the example sites, prints the renderer state as JSON, and exits. It's useful in CI.

## Android (Capacitor)

```sh
cd mobile
npm install
npm run assets         # adaptive icons and light/dark splash from mobile/assets/
npm run apk            # signed release APK -> mobile/out/site-status-<version>.apk
```

- On first run, `npm run apk` creates a release keystore (`android/site-status-release.jks` and `android/keystore.properties`, both gitignored). **Back them up.** Android refuses to install an update signed with a different key.
- The build uses Android Studio's bundled JDK (`jbr/`) unless `JAVA_HOME` is set. Gradle provisions the JDK 21 toolchain that some plugins require.
- To install, copy the APK to the device and allow installs from that source. You can also use `adb install mobile/out/site-status-<version>.apk`.
- Checks only run while the app is in the foreground.

## Browser sidebar extension (no server)

A Chrome/Edge side panel and a Firefox sidebar, built from the same `web/` front end. The extension's own requests aren't subject to CORS for sites it has permission to access, so it shows **real HTTP status codes without the API tier**. It uses Chrome's `webRequest` API to add the server IP, an approximate time to first byte, and precise network errors (DNS, TLS, refused…).

```sh
npm run build:extension      # dist/extension/{chrome,firefox}/ + .zip packages (~170 KB)
npm run build:extension -- --out <dir>   # same, written to <dir> instead
npm run build:extension:all  # build:extension, then a local .git/hooks/build-local-extensions hook if present
npm run test:extension       # end-to-end test in Chrome for Testing (separate profile)
```

- **Install (Chrome / Edge / Brave):** open `chrome://extensions` (or `edge://extensions`), turn on *Developer mode*, choose *Load unpacked*, and pick `dist/extension/chrome`. Then click the toolbar button to open the side panel. To publish, upload `site-status-chrome-<version>.zip` to the Chrome Web Store (one-off $5 developer fee) or Edge Add-ons (free).
- **Install (Firefox 140+):** for testing, use `about:debugging` → *This Firefox* → *Load Temporary Add-on*, and pick `dist/extension/firefox/manifest.json`. For permanent installs, the zip must be signed by Mozilla; uploading it as *unlisted* on addons.mozilla.org is free and gives you a signed `.xpi` to distribute yourself.
- **Permissions:** no site access is requested at install. Adding a site asks for that site; *Settings → Allow checks on all sites* grants everything at once. Imported sites get a *Grant access* prompt.
- **Background checks:** while the sidebar is open, checks run at the chosen interval (down to 5 s). When it's closed, the background worker keeps checking, at most every 30 s (a browser limit). The toolbar badge counts sites that are down, and notifications fire when a site goes down or recovers. You can turn notifications off in Settings.
- **Storage:** data is kept in the extension's `chrome.storage.local`, separate from the PWA's `localStorage`. Use Export/Import to move a site list between them.

## Data

Sites, settings and the last 90 checks per site are stored in `localStorage` on each device. Use **Sites → Export / Import** to move a list between devices. The file format is:

```json
{ "app": "site-status", "version": 1, "sites": [ { "name": "Example", "url": "https://example.com" } ] }
```

Import also accepts a bare `[{ "name", "url" }]` array, and can merge with or replace the current list.

## Licence

[MIT](LICENSE). Google Sans is bundled under the SIL Open Font License 1.1.
