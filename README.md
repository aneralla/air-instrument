# Air Guitar

A virtual guitar you play with your webcam. The app shows chord fingerings for popular songs, and you strum by sweeping your hand across the guitar body on screen.

## Run

```bash
python3 -m http.server 8080
```

Open http://localhost:8080

## How it works

- **Guitar image**: A Les Paul with chord finger positions (colored dots) overlaid on the fretboard
- **Strum zone**: Camera tracks your hand on the guitar body area. Sweep down to strum — crossing string lines triggers each string's note
- **Auto-play**: Click "Auto" to hear the song play itself with visual strum animation. Choose between Simple (one down per beat) and Realistic (D-DU-UDU) patterns
- **Strum width**: Adjustable slider to set how wide the strum detection zone is
- **Chord progression**: Select a song, click Play. Chords auto-advance at the song's BPM. Click any chord pill to preview its fingering

## Data sources

- **Chord voicings**: Fetched from [ChordDB](https://github.com/tombatossals/chords-db) CDN at runtime
- **Song progressions**: Served from `songs.json` (16 songs with beginner-friendly chord progressions)

## Audio

Karplus-Strong string synthesis — each string is independently synthesized by feeding white noise through a tuned delay line with a low-pass filter. This produces a realistic plucked-string sound with no external audio files.
