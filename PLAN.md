# Site Status — Implementation Plan

A lightweight "heartbeat" monitor: checks a user-managed list of sites on a fixed interval and shows up/down, HTTP status and response time as a running, status-page-style chart.

Deliverables: **installable PWA**, **Electron** (Windows, macOS, Debian Linux), **Capacitor** (Android).

---

## 0. Decisions (confirmed 2026-10-02)

| Topic | Decision |
|---|---|
| API tier | **Node.js everywhere** (zero runtime deps). C# was dropped: it can't run inside Capacitor and would add a 35–70 MB .NET sidecar to every Electron build. |
| Probe engine | One module, `shared/probe.mjs`. It runs in the hosted API and in the Electron main process (via IPC). Android uses Capacitor's native `CapacitorHttp`. |
| Hosting | **Local Docker container** (`docker compose up`). It serves the PWA and the API on `http://localhost:8080`; `localhost` is a secure context, so the PWA is installable. `ALLOW_PRIVATE=true` by default for local use, so LAN/intranet sites can be monitored. |
| Code signing | **Self-generated certificates.** Windows: a self-signed Authenticode cert (SmartScreen still warns until the cert is trusted on the machine). macOS: ad-hoc signing, which Apple Silicon needs to launch; Gatekeeper requires right-click → Open on first launch. Android: a self-generated release keystore. |
| Android distribution | **Direct download** of a signed release APK. No Play Store listing, no AAB. |

---

## 1. Goals and non-goals

**Goals**
- Vanilla HTML5 / ES modules / CSS3 with no front-end framework and no bundler. The same `web/` folder ships in all three deliverables.
- Accurate up/down, HTTP status and response time where the platform allows. Honest "limited data" reporting where it doesn't (browser fallback).
- Small install footprint and no runtime dependencies beyond the host platform.

**Non-goals (v1)**
- Accounts, a server-side site list, or multi-user sharing. Sites stay in localStorage.
- Background monitoring while the Android app is suspended. That would need native WorkManager; see §11.
- Alerting by email or webhook. Desktop/OS notifications are a v1.1 candidate.

---

## 2. Repository layout

```
web/                    Front-end (the PWA itself; also packaged by Electron & Capacitor)
  index.html
  manifest.webmanifest
  sw.js                 Service worker (app-shell cache; never caches probe calls)
  css/  tokens.css, app.css
  js/   app.js, store.js, scheduler.js, classify.js, chart.js, popover.js,
        sites-dialog.js, io.js, theme.js,
        transports/{index,native,api,browser}.js   (native = Electron + Capacitor)
  fonts/                Self-hosted Google Sans woff2 (from fonts.google.com, OFL)
  icons/                Generated (see §9)
shared/
  probe.mjs             Node probe engine (used by api/ and desktop/)
  ssrf-guard.mjs        Private-address blocking for the hosted API
api/
  server.mjs            Zero-dep HTTP server: /api/health, /api/probe, /api/probe/batch, + static web/
  Dockerfile
desktop/                Electron wrapper
  main.mjs, preload.cjs, package.json (electron-builder config), build/ (icons)
mobile/                 Capacitor Android wrapper
  capacitor.config.json, package.json, assets/ (icon & splash sources), android/ (generated)
scripts/
  generate-assets.mjs   Icons / splash from one parametric SVG  ✅ done
  fetch-fonts.mjs       Downloads Google Sans woff2 into web/fonts
  build-web.mjs         Copies web/ -> dist/web, stamps version into sw.js cache name
.github/workflows/      CI matrix: web+api, electron (win/mac/linux), android
```

---

## 3. Probe protocol (shared by every transport)

**Result object** (one per check, also what the history stores):

```jsonc
{
  "siteId": "k3x9…",
  "url": "https://example.com",
  "checkedAt": "2026-10-02T14:03:11.402Z",   // UTC ISO-8601; UI renders local + UTC
  "state": "up" | "slow" | "warn" | "down" | "opaque" | "blocked",
  "status": 200,                 // null when unknown (opaque / network error)
  "statusText": "OK",
  "method": "HEAD",              // HEAD, retried as GET on 405/501
  "timings": { "dns": 12, "connect": 18, "tls": 41, "ttfb": 96, "total": 97 }, // ms; subset when limited
  "redirects": 1, "finalUrl": "https://www.example.com/",
  "transport": "server" | "electron" | "native" | "browser",
  "error": null                  // e.g. "ETIMEDOUT", "ENOTFOUND", "TLS: certificate expired"
}
```

**Classification** (`classify.js`, one pure function shared by all transports):

| State | Rule | Colour | Glyph |
|---|---|---|---|
| `up` | 2xx/3xx and total < slow threshold (default 2000 ms) | green | ✓ |
| `slow` | 2xx/3xx and total ≥ threshold | amber | ◔ |
| `warn` | 4xx: the site answered but rejected the request (401/403/404…) | amber-orange | ! |
| `down` | 5xx, timeout, DNS/connect/TLS failure | red | ✕ |
| `opaque` | Browser fallback reached the host but CORS hid the status | slate blue | ? |
| `blocked` | Browser can't attempt it (an `http://` target from an `https://` page, i.e. mixed content) | grey, hatched | ⊘ |

**HTTP API** (hosted Node server):
- `GET /api/health` → `{ "status": "ok", "version": "0.1.0" }`
- `GET /api/probe?url=…` → one result
- `POST /api/probe/batch` `{ "urls": [...] }` → results array. One request per tick, max 50 URLs.

**Probe engine rules**
- `HEAD` first, then fall back to `GET` on 405/501. For a `GET`, stop reading after the headers; the response time is the TTFB.
- Follow up to 5 redirects and report `finalUrl`. Timeout = `clamp(interval × 0.8, 3 s, 10 s)`.
- Send a `User-Agent: SiteStatus/<version>` header and `Cache-Control: no-cache`.

**Hosted API security.** Any server that fetches arbitrary URLs is an SSRF risk.
- Resolve DNS in a custom `lookup`, and **reject private, loopback, link-local and metadata ranges** (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7, …). Validation happens on the IP actually connected to, which defeats DNS rebinding. `ALLOW_PRIVATE=true` disables this for intranet deployments.
- Only `http:`/`https:` schemes and ports 80/443/8000–9999 (configurable).
- Per-IP rate limit, max batch size, and a CORS allow-list (`CORS_ORIGINS`, default: same origin). There are no cookies, so `credentials` are never allowed.
- Electron's local probe allows private addresses, because it's the user's own machine and network.

---

## 4. Front-end transports and fallback chain

`transports/index.js` picks the **first available transport**, re-evaluates when the API health changes, and shows the active one as a badge in the header ("Server probe", "Native probe", "Browser probe · limited").

1. **Electron**: `window.siteStatus.probeBatch(urls)` is exposed by the preload via `contextBridge` and runs `shared/probe.mjs` in the main process. Full fidelity.
2. **Capacitor native**: `Capacitor.Plugins.CapacitorHttp.request({ method:'HEAD', url, connectTimeout, readTimeout })`. CORS-free, gives real status codes. Timing is measured in JS with `performance.now()`; the bridge overhead is a few ms and is noted in the popover.
3. **Hosted API**: `fetch(`${apiBase}/api/probe/batch`)`. `apiBase` defaults to same-origin and can be set in Settings.
   - Health is checked at startup and every 5 minutes.
   - After 2 consecutive failures it **drops to the browser fallback** and shows a toast, then keeps retrying health in the background and promotes itself back when the API returns.
4. **Browser fallback**: `fetch(url, { mode:'no-cors', cache:'no-store', redirect:'follow', signal })`.
   - A resolved promise means the host is reachable, but the response is **opaque**: status is `0` and hidden, and redirects are unknown. The result is `opaque`.
   - A rejected promise (TypeError) means a network failure, so the result is `down`. The popover warns that this can also be caused by an ad-blocker, a corporate proxy or the browser's privacy settings.
   - Timing comes from `performance.now()`. It's refined with `PerformanceResourceTiming.duration` when the entry is available; cross-origin entries without `Timing-Allow-Origin` still expose `duration`.
   - `http://` targets from an `https://` page aren't attempted (mixed content), so they're marked `blocked`.
   - Uptime % excludes `opaque` and `blocked` checks, and the UI says so.

---

## 5. Data and storage (localStorage)

| Key | Content |
|---|---|
| `sitestatus.sites.v1` | `[{ id, name, url, createdAt }]`, in display order |
| `sitestatus.settings.v1` | `{ intervalSec: 60, theme: "system", apiBase: "", slowMs: 2000, historyLen: 90 }` |
| `sitestatus.history.v1` | `{ [siteId]: Result[] }`, a ring buffer of the last 90 results per site (about 15 KB per site) |

- All reads go through `store.js`, which handles versioned keys, schema validation, `try/catch` on quota errors or disabled storage (with an in-memory fallback and a warning banner), and the `storage` event for multi-tab sync.
- Persisting history is an addition to your brief, so the chart survives a reload. It can be cleared from Settings.
- Removing a site deletes its history.

**Export/import JSON**

```json
{ "app": "site-status", "version": 1, "exportedAt": "2026-10-02T14:00:00Z",
  "sites": [ { "name": "Example", "url": "https://example.com" } ] }
```

- **Import** validates the schema, accepts only `http(s)` URLs, strips unknown fields, and asks **Merge** (de-duplicate by normalised URL) or **Replace**. It also accepts a bare `[{name,url}]` array.
- **Export and import file I/O per platform:**
  - Web and Electron: Blob download plus `<input type=file>`.
  - Electron (nicer): `dialog.showSaveDialog` / `showOpenDialog` through the preload.
  - Android: `@capacitor/filesystem` + `@capacitor/share`, because Blob downloads don't work in the Android WebView. Import uses `<input type=file>`, which works.

---

## 6. Scheduler

- A single global interval, chosen from a `<select>` of **5 s, 10 s, 15 s, 30 s, 1 min (default), 2 min, 5 min, 10 min, 15 min**. It's persisted and applies to every site.
- Each tick probes all sites. Batched transports send one call; the browser transport is limited to 6 concurrent requests.
- **No overlap**: if a tick is still running, the next one is skipped and logged.
- There's also a **"Check now"** button. Adding a site probes it immediately.
- **Timer drift and throttling**:
  - The next tick is scheduled from wall-clock time.
  - On `visibilitychange` → visible, the app probes immediately if a tick is overdue. Chrome throttles hidden-tab timers to about 1/min after 5 minutes, and the UI shows this as a note.
  - Electron sets `backgroundThrottling: false`.
  - Android monitors only while in the foreground in v1.

---

## 7. UI and UX

**Layout** (single page, status-page inspired):

```
┌──────────────────────────────────────────────────────────────────────┐
│ [logo] Site Status        ● Server probe   Every [1 min ▾] ⟳  ◐  ⚙  │
├──────────────────────────────────────────────────────────────────────┤
│  ✓ All systems operational                     Updated 14:03:11       │
├──────────────────────────────────────────────────────────────────────┤
│ Example            ✓ 200 · 96 ms                         99.8 %       │
│ example.com  ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮   │
│              90 checks ago ─────────────────────────────── now        │
│ API             ✕ 503 · 1.2 s                            97.1 %       │
│ api.example…  ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮   │
└──────────────────────────────────────────────────────────────────────┘
```

- **Overall banner**: "All systems operational", "Degraded performance", or "N sites down".
- **Rows**: name, host, current state pill (glyph + code + time), uptime % over the displayed window, and a strip of uniform-height bars like an Atlassian status page. Empty slots render as "no data" grey.
- **Responsive bar count**: a container query shows 90 bars wide, 60 on tablet and 30 on phone. History always keeps 90.
- **Rendering**: one inline SVG per row, updated incrementally (shift plus append, with no full re-render) and a single delegated `pointermove`/`focus` handler.
- **Popover**: a single reused element using the native Popover API (`popover="manual"`), positioned in JS and flipped at viewport edges. CSS anchor positioning is a progressive enhancement. It shows:
  - Site name and URL (final URL if redirected)
  - **Local timestamp** (`Intl.DateTimeFormat`, with zone name) and **UTC timestamp**
  - State glyph and label, plus `HTTP 200 OK`, or the error text
  - Response time, a DNS / connect / TLS / TTFB breakdown when available, the method, the redirect count, and the transport (with the "limited" explanation for browser probes)
- **Popover input**:
  - Mouse: shown on hover.
  - Touch: tap to show, tap elsewhere to dismiss.
  - Keyboard: the strip is one tab stop with ←/→ roving across bars and `Esc` to close. An `aria-live` region carries the text.
- **Manage Sites**: a `<dialog>` with a list, Add/Edit (Name and URL, validated with the `URL` constructor; `https://` is prefilled), Delete (with undo toast), Reorder (↑/↓ buttons; they work with touch and keyboard, unlike HTML5 drag-and-drop), and Import/Export.
- **Empty state**: "Add your first site" with an *Add example sites* shortcut.
- **Settings**: theme, API base URL (with a test button), slow threshold, clear history, and About (version, transport).

**Theme**
- CSS custom properties live in `tokens.css`, with `color-scheme: light dark`.
- `@media (prefers-color-scheme: dark)` drives the **System** mode. A `data-theme="light|dark"` attribute on `<html>` overrides it from a System / Light / Dark toggle, and the choice is persisted.
- A `<meta name="theme-color">` is set for each scheme. Electron uses `nativeTheme`, and Android uses the `@capacitor/status-bar` style.
- Status colours are validated for ≥ 3:1 contrast against both backgrounds and are never the only cue, because the glyphs and labels repeat them.

**Font**
- **Google Sans** from fonts.google.com (OFL), weights 400/500/700. It's **self-hosted** as woff2 in `web/fonts/` by `scripts/fetch-fonts.mjs`, so it works offline in the PWA, Electron and Android, with no third-party request and nothing to add to the CSP.
- Stack: `"Google Sans", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`, with `font-display: swap`.
- Tabular numerals are used for times and percentages.

---

## 8. Platform packaging

**PWA**
- `manifest.webmanifest`:
  - Name, short_name, `display: standalone`, `start_url: "./"`, `scope`.
  - Theme and background colours.
  - Icons: 192/512 `any`, 192/512 `maskable`, plus monochrome.
  - A `shortcuts` entry for "Check now". Screenshots are added once the UI exists.
- `sw.js`: precaches the app shell (versioned cache name), is cache-first for static files and **network-only for `/api/*`**, cleans up old caches on activate, and shows an update-available toast.
- An install button via `beforeinstallprompt`, plus iOS "Add to Home Screen" hint text.
- It must be served over HTTPS. The SW isn't registered under Electron or Capacitor.

**Electron** (`desktop/`)
- The page loads from a custom `app://` protocol, not `file://`, which gives a stable origin for localStorage and a working CSP.
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, with a strict CSP.
- The preload exposes only `probeBatch`, `saveFile` and `openFile`.
- The window shows on `ready-to-show` with a `backgroundColor` that matches the theme, so there's no white flash and no separate splash window is needed. Window bounds are remembered.
- `electron-builder` targets:
  - **Windows**: NSIS installer, x64 and arm64.
  - **macOS**: DMG, universal (x64 + arm64). Signing and notarization need an Apple Developer ID.
  - **Linux**: `.deb`, amd64 and arm64.
- Installers are about 80–100 MB each, which is the Chromium baseline; the Node probe adds nothing.
- macOS builds must run on macOS, so they're done by the CI matrix.
- A tray icon with a status summary and OS notifications on state change are v1.1.

**Capacitor Android** (`mobile/`)
- `webDir: "../dist/web"`, `CapacitorHttp` enabled, and Android min SDK 24.
- Splash: `@capacitor/splash-screen` (Android 12+ SplashScreen API, with light and dark backgrounds).
- Other plugins: `@capacitor/status-bar`, `@capacitor/filesystem`, `@capacitor/share` and `@capacitor/app` (back button closes dialogs).
- A `network_security_config.xml` allows cleartext so `http://` sites can be probed.
- Icons and splash: `npx @capacitor/assets generate --android` from `mobile/assets/`. It produces adaptive icons (foreground/background), legacy icons and light/dark splash.
- The release APK is about 4–6 MB.

---

## 9. Icons and splash ✅

`npm run assets` (`scripts/generate-assets.mjs`, built on sharp) renders everything from one parametric SVG: a heartbeat line over a row of status-page bars on a deep-navy rounded square.

| Output | Purpose |
|---|---|
| `assets/source/*.svg` | Editable masters: icon, macOS icon, maskable, monochrome, light/dark splash |
| `web/favicon.svg` | Theme-aware favicon (pulse recolours for dark mode) |
| `web/favicon.ico` | 16/32/48, simplified glyph at small sizes |
| `web/icons/icon-{192,512}.png`, `maskable-{192,512}.png` | PWA manifest icons (maskable content inside the 80% safe zone) |
| `web/icons/apple-touch-icon.png` | iOS home screen (180) |
| `web/icons/monochrome-512.png` | Manifest `monochrome` purpose |
| `desktop/build/icon.{png,ico}`, `icon-macos.png`, `icons/NxN.png` | Electron: Windows ICO (16–256), macOS (inset to Apple's icon grid; electron-builder makes the `.icns`), Linux hicolor set |
| `mobile/assets/icon-{only,foreground,background}.png`, `splash{,-dark}.png` | Capacitor assets input: adaptive icon (the tool insets the foreground 16.7%, so the glyph is drawn at 0.9 scale), 2732² light/dark splash |

---

## 10. Testing

- **Unit tests** (`node:test`, no deps):
  - `classify.js`, the store (schema migration, import merge/replace, de-duplication), the scheduler (no-overlap, drift), and timeout clamping.
  - `probe.mjs` against a local test server: 200, 301→200, 405→GET retry, 503, a hang (timeout), and a TLS error.
  - SSRF guard: private IPs, IPv6, and a DNS-rebinding stub.
- **API tests**: CORS headers, batch limits, rate limit.
- **End-to-end** (Playwright, dev-only):
  - Add, edit, delete and reorder sites; export → import round trip.
  - Interval change.
  - Popover on hover, focus and tap.
  - Theme toggle and system emulation.
  - API-down → browser fallback → recovery.
  - Offline PWA load.
- **Manual matrix**: Chrome, Edge, Firefox and Safari (PWA install); Windows 11, macOS 15+ and Debian 12/Ubuntu 24.04 (installers); Android 10 and 14 (themed icons, splash, back button, export share sheet).

---

## 11. Status (2026-10-02)

| Milestone | State | Notes |
|---|---|---|
| 1. Core web app | ✅ Done | Verified in Chrome: dark and light themes, chart, popover (local and UTC times, timing breakdown), manage dialog. Not yet checked visually at phone width. |
| 2. Probe engine and API | ✅ Done | `shared/probe.mjs`, `shared/ssrf-guard.mjs`, `api/server.mjs`. Live failover to the browser verified. Docker image 242 MB (node:24-alpine). |
| 3. PWA polish | ✅ Mostly | Manifest, service worker (only clears its own `site-status-*` caches), install button, update toast. Lighthouse audit still to run. |
| 4. Electron | ✅ Windows and Debian built | Signed NSIS x64/arm64 installers, about 100 MB each. The amd64 `.deb` was installed on a clean Debian 12 and passes the smoke test. The macOS DMG needs a macOS runner (`.github/workflows/build.yml`). |
| 5. Capacitor Android | ✅ APK built, not yet run on a device | Release APK 4.1 MB, signed with a self-generated keystore. Needs a test on a device or emulator; no AVD is installed on the build machine. |
| 6. Hardening | 🟡 Partial | 18 unit tests (`npm test`). README written. Playwright end-to-end tests and an accessibility audit are still to do. |

**Build notes**
- Android Studio's bundled JBR is JDK 25. The Gradle wrapper was raised from 8.14.3 to 9.1.0, and the Foojay toolchain resolver provides the JDK 21 that the Capacitor plugins request.
- electron-builder's default `.deb` dependency list leaves out `libasound2`, so the list is set explicitly, with `t64` alternatives for Debian 13 and Ubuntu 24.04+.

## 12. Milestones

1. **Core web app**: tokens and theme, fonts, store, sites dialog, import/export, scheduler, browser transport, chart and popover. *The usable PWA in browser-fallback mode.*
2. **Probe engine and API**: `shared/probe.mjs`, SSRF guard, `api/server.mjs`, API transport with health, fallback and recovery, Dockerfile.
3. **PWA polish**: manifest, service worker, install flow, offline, update toast, Lighthouse PWA/a11y ≥ 95.
4. **Electron**: app protocol, preload IPC, native file dialogs, electron-builder configs, CI matrix producing NSIS, DMG and deb.
5. **Capacitor Android**: native transport, filesystem/share export, splash and status bar, assets, signed release APK (self-generated keystore).
6. **Hardening**: tests, accessibility audit, docs (README, self-hosting the API, env vars).

**v1.1 candidates**: notifications on state change (Electron/desktop and Android local notifications), Electron tray, per-site keyword/expected-status checks, Android background checks via WorkManager, CSV export of history.

---

## 13. Open questions

None at present. See §0 for the decisions taken.
