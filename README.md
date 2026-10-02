# Site Status

A lightweight heartbeat monitor. Add sites by name and URL and it checks them on a fixed interval, showing up/down, HTTP status and response time as a status-page style history. Hover any bar for the details of that check.

One vanilla HTML/JS/CSS front end ships as:

- a **PWA** served by a small Node API in Docker
- a **desktop app** (Electron) for Windows, macOS and Debian/Ubuntu
- an **Android app** (Capacitor)

## How checks are made

| Where it runs | Checked by | Sees HTTP status? |
|---|---|---|
| Desktop app | Node probe engine in the Electron main process | ✅ plus DNS / connect / TLS / TTFB timings |
| Android app | Native HTTP (`CapacitorHttp`) | ✅ |
| Browser / PWA | The API server (`api/server.mjs`) | ✅ plus timings |
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

## Data

Sites, settings and the last 90 checks per site are stored in `localStorage` on each device. Use **Sites → Export / Import** to move a list between devices. The file format is:

```json
{ "app": "site-status", "version": 1, "sites": [ { "name": "Example", "url": "https://example.com" } ] }
```

Import also accepts a bare `[{ "name", "url" }]` array, and can merge with or replace the current list.

## Licence

[MIT](LICENSE). Google Sans is bundled under the SIL Open Font License 1.1.
