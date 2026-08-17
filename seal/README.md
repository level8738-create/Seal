# Seal Backend

Server-side video pipeline for the Seal client-proofing app. Replaces the
old browser-side `<video>→canvas→MediaRecorder` compression pipeline
(which couldn't decode H.265/HEVC in most browsers, capped uploads at
45 seconds, and never persisted video across page reloads) with:

```
upload (raw stream, no base64)
  -> private server storage
  -> FFprobe (inspect actual container/codec/duration/audio)
  -> validate
  -> async FFmpeg job
       - destructive per-region blur+noise degrade
         (same 2x2 grid as the photo watermark pipeline)
       - burned-in watermark text on top
       - transcode to H.264/AAC MP4
  -> persistent, range-servable preview URL
```

## Requirements
- Node.js >= 18 (no npm dependencies — uses only built-in `http`/`fs`/
  `crypto`/`child_process`, so `npm install` isn't needed)
- `ffmpeg` and `ffprobe` on `PATH`, built with `libx264` and `libx265`

## Run
```
node server.js          # listens on :8787 (override with PORT=xxxx)
```
Serves the API and, if present, `public/seal-prototype.html` at `/`.

## API
- `POST /api/jobs` `{watermarkText, projectName, filename}` → `{jobId}`
- `PUT /api/jobs/:id/upload` — raw video bytes as the request body
  (`Content-Type` = the file's mime type). Runs FFprobe synchronously
  and responds 202 once validated; FFmpeg processing continues async.
- `GET /api/jobs/:id` — `{status, progress, previewUrl, probe, paid}`
  (`status`: `queued|processing|done|error`)
- `GET /api/jobs/:id/preview.mp4` — protected, watermarked preview
  (Range-request support for browser `<video>` seeking)
- `GET /api/jobs/:id/original` — 403 until `paid`; then streams the
  original upload
- `POST /api/jobs/:id/mark-paid` — demo owner action, sets `paid:true`

## Known limitations
- No auth/multi-tenancy — this is a single-process prototype backend;
  a real deployment needs auth on every endpoint and per-user storage
  scoping.
- Job/file state is a flat JSON file + local disk (`data/jobs.json`,
  `storage/`) — fine for a demo, not for horizontal scaling. Swap for
  a real DB + object storage (S3/GCS) for production.
- The destructive watermark filter graph approximates the browser
  pipeline's blur/shift/noise blend with `boxblur` + `noise` per
  region — visually and functionally equivalent (irreversible pixel
  destruction under the burned text) but not a pixel-identical port.
- Text width for sizing the destructive/watermark box is estimated
  (no server-side canvas to measure exact glyph widths); very long
  watermark strings may render slightly smaller/larger than the
  browser's photo watermark for the same text.
- `window.storage` (project/media metadata persistence) is a Claude
  Artifacts-only API — it won't work when this HTML is served outside
  claude.ai (e.g. via this backend's own `/`), only project *video
  processing* was moved server-side per the task scope.
