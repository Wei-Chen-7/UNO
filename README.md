# UNO Offline

A complete single-player UNO card game that runs 100% offline — one
self-contained `index.html` (all CSS/JS inline, cards drawn with CSS/SVG,
sounds synthesized with WebAudio, zero network requests) plus an optional
`sw.js` that turns it into an installable PWA.

- **You vs 1–3 bots** (default 3), standard 108-card rules: match by color,
  number, or symbol; Skip / Reverse / +2 / Wild / Wild +4; draw-pile
  reshuffle; UNO call & catch; round scoring (numbers face value,
  actions 20, wilds 50) to 500, or single-round mode.
- **House rules** (Settings, off by default): stack +2 on +2, draw until
  playable. Plus bot count, mute, and win/loss stats — all saved in
  localStorage.
- **Bots** hold action cards until the next player is low, pick their
  dominant color for wilds, save Wild +4 as a last resort, auto-call UNO
  but occasionally forget (tap CATCH! to punish them).

## Get it on your phone

**Easiest — host it once, install, then it works in airplane mode:**

1. The included workflow (`.github/workflows/pages.yml`) deploys to
   GitHub Pages automatically on every push to this branch and enables
   Pages on its first run. (Manual alternative: Settings → Pages →
   Deploy from a branch.)
2. Open https://wei-chen-7.github.io/UNO/ on your phone once while online.
3. *Add to Home Screen* (Android Chrome: ⋮ → Add to Home screen;
   iOS Safari: Share → Add to Home Screen).
4. Launch from the icon — fullscreen, fully offline from then on.

**No hosting at all:** send `index.html` to your phone (email it to
yourself, AirDrop, Drive/Files) and open it in the browser. The game is
fully playable offline this way too — you just don't get the home-screen
icon/fullscreen wrapper, which needs the service worker (https).

## Development

- `node uno.test.js` — scenario tests for every rule/flow plus a
  1000-match fuzz that asserts no crashes, exact 108-card conservation
  after every action, and that every game terminates.
- The engine is pure and DOM-free in `<script id="uno-engine">` inside
  `index.html`; the test harness extracts and runs that exact block, so
  there is a single source of truth.
- `sw.js` generates the web-app manifest and the icons at fetch time
  (OffscreenCanvas → PNG), so the repo ships no binary assets.

Append `?seed=123` to the URL for a reproducible shuffle.
