'use strict';
/*
 * Seal backend — server-side video pipeline.
 *
 *   upload (raw stream, no base64) -> private storage -> ffprobe
 *   -> validate -> async ffmpeg (destructive watermark + H.264/AAC encode)
 *   -> protected preview MP4 served to the browser.
 *
 * Zero npm dependencies (sandbox has no network access for `npm install`,
 * and this way the backend runs anywhere with just Node + ffmpeg/ffprobe
 * on PATH). Uses only Node's built-in http/fs/crypto/child_process.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { probe, processVideo } = require('./lib/ffmpeg');
const store = require('./lib/store');

const PORT = process.env.PORT || 8787;
const PRIVATE_DIR = path.join(__dirname, 'storage', 'private');
const PREVIEW_DIR = path.join(__dirname, 'storage', 'previews');
for (const d of [PRIVATE_DIR, PREVIEW_DIR]) fs.mkdirSync(d, { recursive: true });

// ---- limits -----------------------------------------------------------
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2GB hard ceiling
const MAX_DURATION_SEC = 60 * 60; // 1 hour
const ALLOWED_VIDEO_CODECS = new Set([
  'h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg2video', 'mpeg4', 'msmpeg4v2',
  'msmpeg4v3', 'wmv2', 'wmv3', 'theora', 'mjpeg',
]);

/* Mirrors the frontend's buildWatermarkText() exactly (see
 * seal-prototype.html) so the burned-in server watermark and any
 * client-side overlay text always read identically. */
function buildWatermarkText(watermarkText, projectName) {
  const clientLabel = (watermarkText && watermarkText.trim()) ? watermarkText.trim() : 'PAY TO UNLOCK';
  const nameLabel = (projectName && projectName.trim()) ? projectName.trim().toUpperCase() : '';
  const parts = [clientLabel];
  if (nameLabel) parts.push(nameLabel);
  parts.push('SEAL.APP');
  return parts.join('   •   ');
}

function send(res, status, bodyObj, extraHeaders) {
  const body = JSON.stringify(bodyObj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  }, extraHeaders || {}));
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error('body too large')); req.destroy(); return; }
      data += c;
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function extFromContentType(ct) {
  const map = {
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv',
    'video/webm': '.webm', 'video/x-msvideo': '.avi', 'video/mpeg': '.mpg',
    'video/MP2T': '.ts', 'video/3gpp': '.3gp',
  };
  return map[ct] || '.bin';
}

/* Streams the raw request body directly to disk. No FileReader, no
 * base64, no buffering the whole file in memory — this is a straight
 * pipe from the socket to a write stream, so upload size is bounded
 * only by disk, not by process memory. */
function streamUploadToDisk(req, destPath, maxBytes) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const ws = fs.createWriteStream(destPath);
    let aborted = false;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        aborted = true;
        req.unpipe(ws);
        ws.destroy();
        fs.unlink(destPath, () => {});
        reject(Object.assign(new Error('file exceeds size limit'), { code: 'TOO_LARGE' }));
        req.destroy();
      }
    });
    req.on('error', (e) => { if (!aborted) reject(e); });
    ws.on('error', (e) => { if (!aborted) reject(e); });
    ws.on('finish', () => { if (!aborted) resolve(received); });
    req.pipe(ws);
  });
}

async function runProcessingJob(jobId) {
  const job = store.getJob(jobId);
  if (!job) return;
  try {
    store.updateJob(jobId, { status: 'processing', progress: 0 });
    const outputPath = path.join(PREVIEW_DIR, `${jobId}.mp4`);
    const result = await processVideo({
      inputPath: job.originalPath,
      outputPath,
      probeInfo: job.probe,
      watermarkText: buildWatermarkText(job.watermarkText, job.projectName),
      onProgress: (pct) => store.updateJob(jobId, { progress: pct }),
    });
    store.updateJob(jobId, {
      status: 'done',
      progress: 100,
      previewPath: outputPath,
      outW: result.outW,
      outH: result.outH,
      hasAudio: result.hasAudio,
    });
  } catch (err) {
    store.updateJob(jobId, { status: 'error', error: err.message });
  }
}

function serveFileWithRange(req, res, filePath, contentType) {
  fs.stat(filePath, (err, stat) => {
    if (err) { send(res, 404, { error: 'not found' }); return; }
    const range = req.headers.range;
    const headers = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'private, max-age=0',
    };
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      end = Math.min(end, stat.size - 1);
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length'] = end - start + 1;
      res.writeHead(206, headers);
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      headers['Content-Length'] = stat.size;
      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    // ---- create a job -------------------------------------------------
    if (p === '/api/jobs' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const jobId = crypto.randomBytes(8).toString('hex');
      store.createJob(jobId, {
        status: 'created',
        watermarkText: (body.watermarkText || 'PAY TO UNLOCK').toString().slice(0, 200),
        projectName: (body.projectName || '').toString().slice(0, 200),
        filename: (body.filename || 'video').toString().slice(0, 200),
      });
      send(res, 201, { jobId });
      return;
    }

    // ---- upload raw bytes ----------------------------------------------
    let m = p.match(/^\/api\/jobs\/([a-f0-9]+)\/upload$/);
    if (m && req.method === 'PUT') {
      const jobId = m[1];
      const job = store.getJob(jobId);
      if (!job) { send(res, 404, { error: 'unknown job' }); return; }

      const contentType = (req.headers['content-type'] || 'application/octet-stream').split(';')[0];
      const ext = extFromContentType(contentType);
      const originalPath = path.join(PRIVATE_DIR, `${jobId}${ext}`);

      let bytesWritten;
      try {
        bytesWritten = await streamUploadToDisk(req, originalPath, MAX_UPLOAD_BYTES);
      } catch (e) {
        if (e.code === 'TOO_LARGE') { send(res, 413, { error: 'File exceeds the size limit.' }); return; }
        send(res, 400, { error: 'Upload failed: ' + e.message });
        return;
      }

      // FFprobe the actual uploaded bytes — never trust the browser's
      // Content-Type or the fact that <video> couldn't play it locally.
      let info;
      try {
        info = await probe(originalPath);
      } catch (e) {
        fs.unlink(originalPath, () => {});
        store.updateJob(jobId, { status: 'error', error: 'Invalid or corrupt media file.' });
        send(res, 422, { error: 'Invalid or corrupt media file — ffprobe could not read it.' });
        return;
      }

      const vStream = (info.streams || []).find((s) => s.codec_type === 'video');
      if (!vStream) {
        fs.unlink(originalPath, () => {});
        store.updateJob(jobId, { status: 'error', error: 'No video stream found in file.' });
        send(res, 422, { error: 'No video stream found in this file.' });
        return;
      }
      if (!ALLOWED_VIDEO_CODECS.has(vStream.codec_name)) {
        fs.unlink(originalPath, () => {});
        const msg = `Video codec "${vStream.codec_name}" is not supported by this server's FFmpeg build.`;
        store.updateJob(jobId, { status: 'error', error: msg });
        send(res, 422, { error: msg });
        return;
      }
      const duration = parseFloat(info.format && info.format.duration) || 0;
      if (duration > MAX_DURATION_SEC) {
        fs.unlink(originalPath, () => {});
        const msg = `Video is too long (${Math.round(duration)}s). Limit is ${MAX_DURATION_SEC}s.`;
        store.updateJob(jobId, { status: 'error', error: msg });
        send(res, 422, { error: msg });
        return;
      }

      store.updateJob(jobId, {
        status: 'queued',
        originalPath,
        originalBytes: bytesWritten,
        probe: info,
        codec: vStream.codec_name,
        width: vStream.width,
        height: vStream.height,
        duration,
        hasAudioSrc: !!(info.streams || []).find((s) => s.codec_type === 'audio'),
      });

      send(res, 202, {
        jobId,
        status: 'queued',
        probe: { codec: vStream.codec_name, width: vStream.width, height: vStream.height, duration },
      });

      // Kick off async processing — response has already been sent.
      runProcessingJob(jobId);
      return;
    }

    // ---- job status -----------------------------------------------------
    m = p.match(/^\/api\/jobs\/([a-f0-9]+)$/);
    if (m && req.method === 'GET') {
      const job = store.getJob(m[1]);
      if (!job) { send(res, 404, { error: 'unknown job' }); return; }
      send(res, 200, {
        jobId: job.id,
        status: job.status,
        progress: job.progress || 0,
        error: job.error || null,
        paid: !!job.paid,
        previewUrl: job.status === 'done' ? `/api/jobs/${job.id}/preview.mp4` : null,
        probe: job.probe ? { codec: job.codec, width: job.width, height: job.height, duration: job.duration, hasAudio: job.hasAudioSrc } : null,
      });
      return;
    }

    // ---- protected preview ----------------------------------------------
    m = p.match(/^\/api\/jobs\/([a-f0-9]+)\/preview\.mp4$/);
    if (m && req.method === 'GET') {
      const job = store.getJob(m[1]);
      if (!job || job.status !== 'done' || !job.previewPath) { send(res, 404, { error: 'preview not ready' }); return; }
      serveFileWithRange(req, res, job.previewPath, 'video/mp4');
      return;
    }

    // ---- original (payment-gated) ----------------------------------------
    m = p.match(/^\/api\/jobs\/([a-f0-9]+)\/original$/);
    if (m && req.method === 'GET') {
      const job = store.getJob(m[1]);
      if (!job) { send(res, 404, { error: 'unknown job' }); return; }
      if (!job.paid) { send(res, 403, { error: 'Original is locked until payment is confirmed.' }); return; }
      if (!job.originalPath || !fs.existsSync(job.originalPath)) { send(res, 404, { error: 'original not found' }); return; }
      serveFileWithRange(req, res, job.originalPath, 'application/octet-stream');
      return;
    }

    // ---- mark paid (demo owner action) -----------------------------------
    m = p.match(/^\/api\/jobs\/([a-f0-9]+)\/mark-paid$/);
    if (m && req.method === 'POST') {
      const job = store.updateJob(m[1], { paid: true });
      if (!job) { send(res, 404, { error: 'unknown job' }); return; }
      send(res, 200, { ok: true });
      return;
    }

    // ---- serve the frontend for local testing ----------------------------
    if (p === '/' && req.method === 'GET') {
      const htmlPath = path.join(__dirname, 'public', 'seal-prototype.html');
      if (fs.existsSync(htmlPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        fs.createReadStream(htmlPath).pipe(res);
        return;
      }
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: 'Internal server error: ' + err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Seal backend listening on http://localhost:${PORT}`);
});
