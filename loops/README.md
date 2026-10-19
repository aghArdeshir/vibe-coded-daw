# Loop library

The sidebar reads `index.json` in this folder. To add a loop, drop the audio
file (WAV or MP3) here and add a line to `index.json`:

```json
{ "name": "My Loop", "file": "subfolder/my-loop.wav", "bpm": 120, "category": "Drums", "license": "CC0" }
```

`file` is relative to this folder. `bpm`, `category` and `license` are optional
(`category` groups items in the sidebar).

## Licensing — read before committing loops to a public repo

Pushing a loop to a public GitHub repo (and serving it on GitHub Pages)
*redistributes* it. Many "royalty-free" packs let you use the sounds in your own
music but forbid sharing the raw loops, so only commit loops whose license
allows redistribution:

- **CC0 / public domain**: safe to commit.
- **CC-BY**: OK if you credit the author (put it in `license`, e.g. `CC-BY Jane Doe`).
- **CC-NC / CC-ND**, or "royalty-free, no redistribution": don't commit these.
  Load them per session with **+ Add** in the sidebar instead.

## Included demo loops

The four loops in this folder (`*-120.wav`, 120 BPM, 2 bars) were synthesized
for this project and are released under CC0.
