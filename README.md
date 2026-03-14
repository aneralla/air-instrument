# Air Guitar

A virtual guitar you play with your webcam. The app shows chord fingerings for popular songs, and you strum by sweeping your hand across the guitar body on screen.

**Live**: [air-instrument.pages.dev](https://air-instrument.pages.dev)

## Run locally

```bash
python3 -m http.server 8080
```

Open http://localhost:8080

## How it works

- **Guitar image**: A Les Paul with chord finger positions (colored dots) overlaid on the fretboard
- **Strum zone**: Camera tracks your hand on the guitar body area. Sweep down to strum — crossing string lines triggers each string's note
- **Up strum**: Toggle "Up Strum" to enable both down and up strumming directions
- **Strum calibration**: Click "Set Strum" to define your physical strum area on the camera feed (two clicks: top and bottom boundaries)
- **Auto-play**: Click "Auto" to hear the song play itself with visual strum animation. Choose between Simple (one down per beat) and Realistic (D-DU-UDU) patterns
- **Chord progression**: Select a song, click Play. Chords auto-advance at the song's BPM. Click any chord pill to preview its fingering

## Data sources

- **Chord voicings**: Fetched from [ChordDB](https://github.com/tombatossals/chords-db) CDN at runtime
- **Song progressions**: Served from `songs.json` (16 songs with beginner-friendly chord progressions)

## Audio

Karplus-Strong string synthesis — each string is independently synthesized by feeding white noise through a tuned delay line with a low-pass filter. This produces a realistic plucked-string sound with no external audio files.

## Deploy

Hosted on [Cloudflare Pages](https://pages.cloudflare.com/). To deploy after making changes:

```bash
cd /Users/aneralla/Dev/personal/git-repos/air-instrument
git add -A && git commit -m "description of changes"
git push origin main
npx wrangler pages deploy . --project-name air-instrument --branch main --commit-dirty=true
```

The production URL is [air-instrument.pages.dev](https://air-instrument.pages.dev). Each deploy also creates a preview URL shown in the command output.
