// 미디어 파일 정보(길이·트랙)와 HTTP Range 스트리밍
import fs from 'node:fs';
import path from 'node:path';
import { run } from './util.mjs';

export async function probe(file) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=index,codec_type,channels',
      '-of', 'json', file], { timeout: 20000 });
    const j = JSON.parse(stdout);
    const audio = (j.streams || []).filter((s) => s.codec_type === 'audio');
    return {
      durationSec: Number(j.format?.duration) || 0,
      hasVideo: (j.streams || []).some((s) => s.codec_type === 'video'),
      audioTracks: audio.map((s) => ({ index: s.index, channels: s.channels })),
    };
  } catch { return { durationSec: 0, hasVideo: false, audioTracks: [] }; }
}

const TYPES = {
  '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.srt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
export const contentType = (f) => TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream';

export function serveFile(req, res, file, { download = false } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end('not found'); }
  const headers = { 'Content-Type': contentType(file), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (download) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : st.size - 1;
    start = Math.max(0, start); end = Math.min(end, st.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

export function dirBytes(dir) {
  let n = 0;
  try { for (const f of fs.readdirSync(dir)) { try { n += fs.statSync(path.join(dir, f)).size; } catch {} } } catch {}
  return n;
}
