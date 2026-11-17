// 녹화 하나의 결과 점검: 파일별 길이, 마이크 트랙 길이, 화면 변화 기록, 합본 여부
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const id = process.argv[2];
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mac-recorder/config.json'), 'utf8')); } catch { return {}; } })();
const dir = path.join((cfg.recordingsDir || '~/Movies/MacRecorder').replace(/^~/, os.homedir()), id);
const s = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
const dur = (f, sel = '') => {
  try { return Number(execFileSync('ffprobe', ['-v', 'error', ...(sel ? ['-select_streams', sel] : []), '-show_entries', sel ? 'stream=duration' : 'format=duration', '-of', 'csv=p=0', path.join(dir, f)], { encoding: 'utf8' }).trim().split('\n')[0]).toFixed(1); } catch { return '-'; }
};
console.log(`\n${id}  상태=${s.status}  길이=${s.durationSec}s`);
for (const f of [s.media, ...(s.extras || []), 'recording_all.mp4']) {
  if (fs.existsSync(path.join(dir, f))) console.log(`  ${f.padEnd(22)} 전체 ${dur(f)}s · 영상 ${dur(f, 'v:0')}s${f === s.media ? ` · 마이크 ${dur(f, 'a:0')}s` : ''}`);
}
for (const e of s.captureEvents || []) console.log(`  · ${e.at.slice(11, 19)} ${e.type} ${e.name || ''}`);
