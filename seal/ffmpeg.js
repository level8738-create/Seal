'use strict';
const { spawn } = require('child_process');

const FFPROBE = 'ffprobe';
const FFMPEG = 'ffmpeg';

/** Run ffprobe on a file and return parsed JSON stream/format info.
 *  Uses an argument array (spawn), never a shell string — filenames are
 *  never concatenated into a command line. */
function probe(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];
    const proc = spawn(FFPROBE, args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => reject(new Error(`ffprobe failed to start: ${e.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited ${code}: ${err.trim().slice(0, 500) || 'invalid or corrupt media'}`));
        return;
      }
      try {
        const parsed = JSON.parse(out);
        resolve(parsed);
      } catch (e) {
        reject(new Error('ffprobe returned unparsable output — file is likely not valid media'));
      }
    });
  });
}

function escDrawtext(s) {
  // Escape for ffmpeg drawtext's text=' ... ' argument.
  return String(s)
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\u2019")   // swap smart quote in rather than trying to escape it inside single-quotes
    .replace(/%/g, '\\%');
}

/** Builds the destructive-watermark + transcode filter graph.
 *  Mirrors the browser pipeline's 2x2 grid (computeWatermarkCells):
 *  cells centered at (27%,30%) (73%,30%) (27%,72%) (73%,72%) of frame.
 *  For each cell: crop -> boxblur + noise (irreversible pixel destruction)
 *  -> overlay back onto the frame -> drawtext burns the visible mark on
 *  top of the now-destroyed region, in the same place every time. */
// No canvas available server-side to measure text, so approximate glyph
// width for a bold sans font (empirically ~0.58x fontSize per character,
// including the bullet/spacer characters) — same shrink-to-fit idea as
// the frontend's ctx.measureText() pass, just estimated instead of exact.
function estimateTextWidth(text, fontSize) {
  return text.length * fontSize * 0.58;
}

function buildFilterGraph(outW, outH, watermarkText) {
  let fontSize = Math.max(16, Math.round(Math.min(outW, outH) * 0.062));
  const maxTextWidth = outW * 0.42;
  let textWidth = estimateTextWidth(watermarkText, fontSize);
  if (textWidth > maxTextWidth) {
    const shrink = maxTextWidth / textWidth;
    fontSize = Math.max(10, Math.round(fontSize * shrink));
    textWidth = estimateTextWidth(watermarkText, fontSize);
  }
  const rectW = Math.round(textWidth + fontSize * 1.6);
  const rectH = Math.round(fontSize * 2.4);
  const cellsFrac = [
    [0.27, 0.30], [0.73, 0.30],
    [0.27, 0.72], [0.73, 0.72],
  ];
  const text = escDrawtext(watermarkText);

  const cells = cellsFrac.map(([fx, fy]) => {
    const cx = Math.round(outW * fx);
    const cy = Math.round(outH * fy);
    let x = cx - Math.round(rectW / 2);
    let y = cy - Math.round(rectH / 2);
    // Clamp inside frame and keep even width/height (required by some filters/encoders)
    let w = rectW - (rectW % 2);
    let h = rectH - (rectH % 2);
    x = Math.max(0, Math.min(x, outW - w));
    y = Math.max(0, Math.min(y, outH - h));
    return { x, y, w, h, cx, cy };
  });

  const parts = [];
  parts.push(`[0:v]scale=${outW}:${outH}:force_original_aspect_ratio=disable,setsar=1[base]`);
  parts.push(`[base]split=${cells.length + 1}[basemain]${cells.map((_, i) => `[csrc${i}]`).join('')}`);

  cells.forEach((c, i) => {
    // Destructive pass: crop the region, blur it hard, layer random noise on top.
    // Neither operation is invertible from the output pixels alone.
    parts.push(
      `[csrc${i}]crop=${c.w}:${c.h}:${c.x}:${c.y},boxblur=7:2,noise=alls=35:allf=t+u[patch${i}]`
    );
  });

  let last = 'basemain';
  cells.forEach((c, i) => {
    const out = `ov${i}`;
    parts.push(`[${last}][patch${i}]overlay=${c.x}:${c.y}[${out}]`);
    last = out;
  });

  // Burn the visible watermark text on top of every already-destroyed region.
  const drawtexts = cells
    .map((c) => `drawtext=text='${text}':x=${c.cx}-text_w/2:y=${c.cy}-text_h/2:fontsize=${fontSize}:fontcolor=white@0.92:box=1:boxcolor=black@0.35:boxborderw=8`)
    .join(',');
  parts.push(`[${last}]${drawtexts}[vout]`);

  return parts.join(';');
}

/** Transcodes+watermarks a source video into an H.264/AAC MP4 preview.
 *  Runs entirely server-side: decode, destructive watermark burn, encode.
 *  onProgress(pct) is called as ffmpeg reports -progress output.
 *  probeInfo is the ffprobe result for the source (used for duration/dims/audio). */
function processVideo({ inputPath, outputPath, probeInfo, watermarkText, onProgress }) {
  return new Promise((resolve, reject) => {
    const vStream = (probeInfo.streams || []).find((s) => s.codec_type === 'video');
    const aStream = (probeInfo.streams || []).find((s) => s.codec_type === 'audio');
    if (!vStream) { reject(new Error('No video stream found in this file.')); return; }

    const srcW = vStream.width || 1280;
    const srcH = vStream.height || 720;
    const MAX_DIM = 960;
    const scale = Math.min(1, MAX_DIM / Math.max(srcW, srcH));
    let outW = Math.round(srcW * scale);
    let outH = Math.round(srcH * scale);
    outW = outW % 2 === 0 ? outW : outW + 1;
    outH = outH % 2 === 0 ? outH : outH + 1;

    const durationSec = parseFloat(probeInfo.format && probeInfo.format.duration) || parseFloat(vStream.duration) || 0;
    const filterGraph = buildFilterGraph(outW, outH, watermarkText);

    const args = [
      '-y',
      '-i', inputPath,
      '-filter_complex', filterGraph,
      '-map', '[vout]',
    ];
    if (aStream) {
      args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-ac', '2');
    } else {
      args.push('-an');
    }
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '25',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      '-nostats',
      outputPath
    );

    const proc = spawn(FFMPEG, args);
    let stderrTail = '';
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    proc.stdout.on('data', (d) => {
      if (!onProgress || !durationSec) return;
      const text = d.toString();
      const m = text.match(/out_time_ms=(\d+)/) || text.match(/out_time_us=(\d+)/);
      if (m) {
        const doneSec = parseInt(m[1], 10) / 1e6;
        const pct = Math.max(0, Math.min(99, Math.round((doneSec / durationSec) * 100)));
        onProgress(pct);
      }
    });
    proc.on('error', (e) => reject(new Error(`ffmpeg failed to start: ${e.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderrTail.trim().slice(-800) || 'encode failed'}`));
        return;
      }
      if (onProgress) onProgress(100);
      resolve({ outW, outH, hasAudio: !!aStream, durationSec });
    });
  });
}

module.exports = { probe, processVideo, buildFilterGraph };
