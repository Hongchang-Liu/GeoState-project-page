# GeoState project page

This repository contains the static GeoState project page: the project video,
method overview, Interactive Demos, and qualitative/quantitative Comparisons.
It does not contain model weights, latent-state caches, or the GPU backend.

## Publish with GitHub Pages

1. Upload this directory's contents to the root of a GitHub repository, including
   the hidden `.nojekyll` file. Upload with Git rather than the browser file picker.
2. In Settings > Pages, select Deploy from a branch, then `main` and `/(root)`.
3. Open the published URL and check the video, all scene pages, and Comparisons.

The existing relative asset URLs support both a user site and a repository site.
No frontend build step is needed. `.nojekyll` disables Jekyll processing.

## Connect the live decoder

Edit `static/demo/config.js` after a public HTTPS decoder endpoint is ready:

```js
export const API_BASE = 'https://YOUR_ACTUAL_DECODER_HOST';
export const REQUEST_DELAY_MS = 220;
```

The checked-in `API_BASE` is intentionally empty. Until it is configured,
non-localhost visitors see cached references but cannot decode arbitrary views.
Comparisons and cached default-view point clouds do not require the decoder.

The backend must retain `GET /api/health`, `POST /api/decode`, and the existing
binary depth protocol. Configure CORS for the actual page origin, without its
repository path. Allow OPTIONS preflights before POST request-body validation.
Keep request-size, concurrency and rate limits. Never place service credentials,
tunnel tokens, Hugging Face tokens, checkpoints, or private caches here.

## Preview locally

```bash
python3 -m http.server 8080 --bind 127.0.0.1
```

Open `http://127.0.0.1:8080/`. The viewer's existing localhost fallback contacts
`127.0.0.1:8090`; it is normal for that connection to fail without a local decoder.

## Before announcing the page

- Replace the existing `YOUR_DOMAIN` social/SEO metadata with the published URL.
- Set a real social-preview image URL; the template's image does not exist.
- Add the Code and arXiv links when available; they are currently disabled.
- Test live decoding through HTTPS from a network outside the inference LAN.

## Visualization and attribution

Point clouds use corresponding video-frame RGB values for visualization only.
GeoState predicts geometry, not RGB. The selected qualitative examples are not
benchmark averages. Model-side inference, rendering, density and color assets
have not been modified for this release.

The website retains its Creative Commons Attribution-ShareAlike 4.0 notice and
the Academic Project Page Template / Nerfies attribution in the page footer.
This website notice is separate from the MIT license of the model-code repository.
