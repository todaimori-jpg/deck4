# DECK 4 — a browser DJ set for iPad

A four-deck DJ app that runs in iPadOS Safari and installs to the home screen.
No build step, no bundler, no dependencies: it is plain ES modules served
straight from GitHub Pages.

Built for iPad landscape. Everything is local — audio you import never leaves
the device.

## What it does

| | |
|---|---|
| Decks | 4 stereo decks, A/B/C/D, in a 2-deck or 2×2 layout |
| Waveforms | two-band frequency-coloured scrolling waveform (red highs, blue lows) plus a whole-track overview |
| Beat detection | autocorrelation tempo estimate with parabolic peak interpolation, downbeat phase search |
| Fluid beatgrid | piecewise-linear tempo zones — drop markers anywhere and the grid ramps between them |
| Grid editing | tap to add a marker, drag to move, release snaps to the beat, non-destructive and saved per track |
| Master tempo (FLX) | WSOLA time-stretch: tempo changes duration only, pitch holds |
| Sync | matches the master deck's tempo, then glides onto its downbeat within a bar |
| Loops | 1/4 to 8 beat loops, quantised, with auto-relayout on tempo change |
| Hot cues | 8 slots over two pages, quantised, second press returns to where you came from |
| Mixer | gain, 3-band EQ, sweep filter, pan, PFL cue, channel faders, VU meters |
| Master | constant-power or sharp crossfader, 3-band master EQ, brickwall limiter |
| Library | IndexedDB crate — audio bytes, byte-quantised peak envelopes and grid edits survive a reload |
| Offline | service-worker shell cache + web manifest, so "Add to Home Screen" gives a real app |

## Deliberately not here

Cloud sync, timecode control and MIDI were excluded from the start. The
iZotope RX stem separation and the Pattern Player sequencer from the Traktor Pro
4 feature list are **not** in v1 — real stem demixing is a licensed commercial
engine that cannot run in a browser.

## Run it locally

Any static file server works. This repo ships a zero-dependency one:

```bash
node tools/serve.mjs 5173
```

It binds `0.0.0.0` and prints the LAN addresses it found, so you can open
`http://<your-macs-or-pcs-ip>:5173` on an iPad on the same Wi-Fi. Web Audio and
the service worker both need the page served over `http`/`https` — opening
`index.html` from the filesystem will not work.

### If `node` is not on your PATH

This machine has no standalone Node, and the Qoder app bundles one. Reuse it:

```bash
export ELECTRON_RUN_AS_NODE=1
"/c/Users/Internet10/AppData/Local/Programs/Qoder/Qoder.exe" tools/serve.mjs 5173
```

That build is Node 24 but is missing `Buffer#readFloat32LE` / `#writeFloat32LE`,
which is why the tooling reads and writes floats through `DataView`.

## Checks

```bash
node tools/make-fixture.mjs   # writes three synthetic WAVs into fixtures/
node tools/check.mjs src      # syntax gate, every module under src/
node tools/test-analysis.mjs  # 22 checks: tempo, peaks, grid maths, persistence
node tools/test-worklet.mjs   # 23 checks: stretch, pitch, clicks, loops, reverse
```

The worklet suite renders real audio through the actual `DeckProcessor` and
measures it: duration ratio, dominant frequency via a Goertzel sweep, and the
largest single-sample step as a click detector. Fixtures are gitignored —
regenerate them before running the analysis suite.

## Put it on GitHub Pages

Create the repo yourself, then:

```bash
cd "C:/Users/Internet10/Documents/Qoder/2026-10-30/9090bf25"
git init
git add .
git commit -m "DECK 4: iPad DJ web app"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

Then in the repo: **Settings → Pages → Build and deployment → Source: GitHub
Actions**. The included `.github/workflows/deploy.yml` runs the checks and
publishes `index.html`, `src/`, `styles/`, `icons/`, `manifest.webmanifest` and
`sw.js`.

Every push to `main` redeploys. The site lands at
`https://<your-username>.github.io/<repo-name>/` — all paths in the app are
relative, so the project-page sub-path needs no configuration.

**GitHub Pages must be served over HTTPS for the install-to-home-screen flow to
work**, which it is by default.

## Install on the iPad

1. Open the Pages URL in **Safari** (Chrome on iPad does not support home-screen
   web apps).
2. Tap the Share button → **Add to Home Screen**.
3. Launch from the icon and rotate to landscape — it runs fullscreen with no
   browser chrome.

Turn the iPad's silent switch **off**: iOS treats a muted device as a reason to
keep the audio engine asleep.

Import is via **IMPORT FROM FILES**, which opens the system picker, so tracks
can come from the Files app, "On My iPad", iCloud Drive or a connected USB
drive. The first tap on a row selects it, then the `LOAD A B C D` chips put it
on a deck.

## Layout

```
src/
  audio/    deck-worklet.js  WSOLA + sample-accurate transport (AudioWorklet)
            engine.js        graph: decks -> EQ -> limiter -> master, PFL bus
            deck.js          transport intent: tempo, cue, loops, hot cues, sync
  analysis/ analyze.js       peaks, onset flux, tempo
            grid.js          BeatGrid tempo zones, TempoTapper
  ui/       widgets.js       pointer drag, knobs, faders, pads
            waveform.js      scrolling wave, overview, beatgrid strip
            deckview.js      one deck panel
            mixerview.js     channel strips + crossfader
            browser.js       crate tree, search, table
  store/    library.js       IndexedDB crate + packed peak envelopes
  main.js   wiring and the rAF frame loop
```

## Known limits

- iOS may evict the IndexedDB crate if the device runs low on space and the app
  is not installed to the home screen. `navigator.storage.persist()` is
  requested at boot, but the OS decides.
- Analysis runs on import. A long track takes a second or two; the crate row
  appears as soon as it is ready.
- The tempo estimate is locked to the detected grid — for a track with no
  percussive content, tap the grid in with `TAP` or drop a marker yourself.
- Loudness depends on the limiter, so master output is deliberately hot; pull
  the master trim down if it is too much for your monitors.
