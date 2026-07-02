# Sanctum Vox — Interactive Articulator

A 3D interactive model of the human vocal tract for voice and dialect coaching.
Explore how every sound in the IPA is physically produced — tongue, lips, jaw,
velum, and airflow — with real recorded audio for each phoneme.

**Live:** https://sanctumvox.github.io/articulator/

Pure client-side app: plain ES modules + [Three.js](https://threejs.org/), no
backend and no bundler. `build-web.sh` assembles the deployable site into
`web-dist/`; the GitHub Actions workflow in `.github/workflows/pages.yml`
runs it and publishes to GitHub Pages on every push to `main`.

## Run locally

```bash
bash build-web.sh          # assembles web-dist/
cd web-dist && python3 -m http.server 8000
# open http://localhost:8000
```

## Contents

| Path | What |
|------|------|
| `index.html`, `styles.css` | Shell + UI |
| `app.js` | UI wiring, animation, airflow particles, audio playback |
| `vocal-tract.js` | All 3D mesh construction |
| `ipa-data.js` | IPA sound definitions + articulatory parameters |
| `accent-data.js` | GenAm / RP accent reference data |
| `lib/` | Three.js + OrbitControls (vendored) |
| `sounds/` | Per-phoneme audio (IPA recordings) |
| `fonts/` | UI webfonts |

Audio recordings are sourced from Wikimedia Commons (IPA phonetic recordings).

Canonical source lives in the private `SanctumVox/sanctum-vox` monorepo under
`articulator/`; this repository is the public deploy target.

© Sanctum Vox. Code is client-side and viewable; not licensed for reuse.
