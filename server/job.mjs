#!/usr/bin/env node
// 백그라운드 작업 실행기 — 서버가 detached 로 띄운다. 대시보드를 닫아도 끝까지 간다.
//   finalize   녹화 파일 마무리 대기 → 재생용 파일·화면 합본 → 길이 기록 → (자동 전사 켜짐이면) pipeline
//   pipeline   전사 → AI 교정 → AI 요약 (설정에 따라)
//   transcribe / correct / summarize   하나만
// 무거운 단계(전사·AI)는 맥 전체에서 한 번에 하나만 돈다(잠금 파일).
import fs from 'node:fs';
import path from 'node:path';
import { P, REPO, ensureHome, loadConfig } from './lib/config.mjs';
import { readSession, sessionDir, updateSession } from './lib/sessions.mjs';
import { probe } from './lib/media.mjs';
import { alive, run, sleep } from './lib/util.mjs';
import { transcribeSession, whisperStatus } from './lib/transcribe.mjs';
import { correctSession, summarizeSession } from './lib/ai.mjs';
import { providerStatus } from './lib/llm.mjs';

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const id = arg('--id');
const action = arg('--action');
ensureHome();
const dir = sessionDir(id);
const log = (...a) => console.log(`[${new Date().toISOString()}] [${action}]`, ...a);

function setJob(patch) {
  updateSession(id, (s) => ({ ...s, job: { ...(s.job || {}), ...patch, pid: process.pid } }));
}
function setPart(key, patch) {
  updateSession(id, (s) => ({ ...s, [key]: { ...(s[key] || {}), ...patch, updatedAt: new Date().toISOString() } }));
}

// ── 잠금: 맥 전체에서 무거운 작업 하나만 ─────────────────────────
const LOCK = path.join(P.jobs, 'heavy.lock');
async function withLock(fn) {
  setJob({ status: 'queued', step: '앞 작업이 끝나기를 기다리는 중' });
  for (;;) {
    try {
      fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
      break;
    } catch {
      const owner = Number(fs.readFileSync(LOCK, 'utf8')) || 0;
      if (!alive(owner)) { fs.rmSync(LOCK, { force: true }); continue; }
      await sleep(3000);
    }
  }
  try { return await fn(); } finally { try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.rmSync(LOCK, { force: true }); } catch {} }
}

async function finalize() {
  setJob({ status: 'running', step: '녹화 파일 마무리 중' });
  let cap = {};
  const readCap = () => { try { cap = JSON.parse(fs.readFileSync(path.join(dir, 'capture.json'), 'utf8')); } catch {} };
  readCap();
  // 1) 캡처 앱이 파일을 다 쓰고 끝날 때까지
  for (let i = 0; i < 120 && cap.pid && alive(cap.pid); i++) { await sleep(500); readCap(); }
  readCap();
  const s = readSession(id);
  const media = path.join(dir, s.media);
  if (!fs.existsSync(media) || cap.state === 'failed') {
    updateSession(id, { status: 'failed', error: cap.error || '녹화 파일이 만들어지지 않았습니다' });
    setJob({ status: 'error', error: cap.error || '녹화 파일 없음', endedAt: new Date().toISOString() });
    return false;
  }
  // 2) 재생용 믹스(마이크+시스템 소리) — 캡처 앱이 띄운 mix-audio.sh 가 끝날 때까지
  if (s.sources.mic && s.sources.system) {
    setJob({ step: '재생용 소리 합치는 중' });
    const mixed = media.replace(/(\.[^.]+)$/, '_mixed$1');
    for (let i = 0; i < 240 && !fs.existsSync(mixed); i++) await sleep(500);
  }
  // 3) 녹화 엔진이 남긴 파일 목록·화면 변화 기록을 세션에 옮긴다
  const files = (cap.files || []).filter((f) => fs.existsSync(path.join(dir, f.file)));
  const extras = files.filter((f) => f.role === 'extra').map((f) => f.file);
  const captureEvents = (cap.events || []).filter((e) => e.type !== 'start');
  updateSession(id, { extras, captureEvents, displays: files });
  // 4) 여러 화면 → 실제 모니터 배치(왼쪽→오른쪽) 순서로 나란히 합본
  if (extras.length) {
    setJob({ step: '여러 화면 합치는 중' });
    try { updateSession(id, { layout: await stackDisplays(dir, files, s, cap.events || []) }); } catch (e) { log('합본 실패', e.message); }
  }
  const info = await probe(media);
  updateSession(id, { status: 'ready', durationSec: Math.round(info.durationSec), audioTracks: info.audioTracks.length });
  log(`ready ${Math.round(info.durationSec)}s tracks=${info.audioTracks.length}`);
  return info.audioTracks.length > 0;
}

let current = null; // 실패 시 어느 항목에 오류를 적을지
/** 화면별 파일 → 합본(recording_all.mp4).
 *  모니터가 연결돼 있던 구간에만 그 화면을 넣는다. 빠진 구간은 남은 화면만으로 다시 배치해 같은 크기에 맞춘다
 *  (빠진 화면이 마지막 장면으로 멈춰 남지 않게). 구간은 녹화 엔진이 남긴 화면 변화 시각(t, 초)으로 자른다.
 *  모든 파일은 같은 시간축이라(엔진이 시작 시각을 맞춤) 나중에 연결된 화면은 앞부분이 비어 있다. */
async function stackDisplays(dir, files, s, events) {
  const FPS = 30;
  const order = [...files].sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
  const meta = [];
  for (const f of order) {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,start_time',
      '-of', 'json', path.join(dir, f.file)], { timeout: 30000 });
    const st = JSON.parse(stdout).streams?.[0] || {};
    meta.push({ ...f, w: Number(st.width) || 0, h: Number(st.height) || 0, start: Math.max(0, Number(st.start_time) || 0) });
  }
  const D = (await probe(path.join(dir, s.media))).durationSec;
  const H = Math.max(...meta.map((m) => m.h)) & ~1;
  if (!H || !D) throw new Error('영상 크기·길이를 읽지 못함');
  for (const m of meta) m.pw = Math.round((m.w * H) / m.h / 2) * 2; // 높이 H 로 맞췄을 때 폭

  // 화면별 연결 구간. 시각(t)이 없는 옛 엔진 기록이면 처음부터 끝까지 연결된 것으로 본다(예전 방식).
  const timed = events.some((e) => typeof e.t === 'number' && e.file);
  const online = (m, t) => {
    if (m.role === 'primary' || !timed) return true;
    const mine = events.filter((x) => x.file === m.file);
    // 처음부터 녹화한 화면(«start» 기록)은 0초부터 연결된 것으로 본다(연결 기록이 시작보다 조금 늦게 남는다)
    let on = mine.some((x) => x.type === 'start');
    for (const e of mine.filter((x) => typeof x.t === 'number' && x.type !== 'start').sort((x, y) => x.t - y.t)) {
      if (e.t > t) break;
      if (/start|added|resumed/.test(e.type)) on = true;
      if (/lost/.test(e.type)) on = false;
    }
    return on;
  };
  const cuts = [...new Set([0, D, ...(timed ? events.filter((e) => e.file && e.file !== s.media && e.type !== 'start' && typeof e.t === 'number' && e.t > 0 && e.t < D).map((e) => e.t) : [])])].sort((a, b) => a - b);
  const segs = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    if (b - a < 0.2 && segs.length) { segs[segs.length - 1].b = b; continue; }
    segs.push({ a, b, active: meta.filter((m) => online(m, (a + b) / 2)) });
  }
  // 이어진 같은 배치는 합친다
  const merged = [];
  for (const g of segs) {
    const last = merged[merged.length - 1];
    if (last && last.active.map((m) => m.file).join() === g.active.map((m) => m.file).join()) last.b = g.b; else merged.push({ ...g });
  }
  // 합본 화면(캔버스)의 비율은 주 화면 하나의 비율. 화면이 하나뿐인 구간은 꽉 차고, 여러 개인 구간은 나란히 맞춰 넣는다.
  // (예전에는 «모든 화면을 나란히 놓은» 가로로 긴 캔버스라, 화면이 하나 남으면 가운데에 작게 보였다 — 2026-11-18 피드백)
  // 폭은 여러 화면을 나란히 놓았을 때의 폭(최대 3840)을 유지해 여러 화면 구간의 선명도도 지킨다.
  const prim = meta.find((m) => m.role === 'primary') || meta[0];
  const layoutW = Math.max(...merged.map((g) => g.active.reduce((n, m) => n + m.pw, 0)));
  const W = Math.min(layoutW, 3840) & ~1;
  const CH = Math.round(W / (prim.w / prim.h) / 2) * 2;

  // 각 파일을 [0, D] 전체를 덮는 고정 프레임 영상으로 만든 뒤(앞의 빈 곳은 검정, 화면이 그대로인 동안은 직전 장면) 구간마다 잘라 쓴다
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  meta.forEach((m) => args.push('-i', path.join(dir, m.file)));
  const mixed = s.media.replace(/(\.[^.]+)$/, '_mixed$1');
  args.push('-i', path.join(dir, fs.existsSync(path.join(dir, mixed)) ? mixed : s.media));
  const parts = [];
  meta.forEach((m, i) => {
    const uses = merged.filter((g) => g.active.includes(m)).length;
    if (!uses) return;
    const pad = m.start > 0.05 ? `,tpad=start_duration=${m.start.toFixed(3)}:start_mode=add:color=black` : '';
    parts.push(`[${i}:v]setpts=PTS-STARTPTS${pad},fps=${FPS},tpad=stop_mode=clone:stop_duration=${Math.ceil(D) + 1},scale=${m.pw}:${H},setsar=1${uses > 1 ? `,split=${uses}` : ''}${Array.from({ length: uses }, (_, k) => `[c${i}_${k}]`).join('')}`);
  });
  const used = meta.map(() => 0);
  merged.forEach((g, j) => {
    const ins = g.active.map((m) => { const i = meta.indexOf(m); const lab = `c${i}_${used[i]++}`; parts.push(`[${lab}]trim=start=${g.a.toFixed(3)}:end=${g.b.toFixed(3)},setpts=PTS-STARTPTS[t${j}_${i}]`); return `[t${j}_${i}]`; });
    const lay = ins.length > 1 ? `${ins.join('')}hstack=inputs=${ins.length}` : `${ins[0]}null`;
    parts.push(`${lay},scale=${W}:${CH}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${CH}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[g${j}]`);
  });
  parts.push(`${merged.map((_, j) => `[g${j}]`).join('')}concat=n=${merged.length}:v=1:a=0[v]`);
  const out = path.join(dir, 'recording_all.mp4');
  const base = [...args, '-filter_complex', parts.join(';'), '-map', '[v]', '-map', `${meta.length}:a:0?`];
  const tail = ['-c:a', 'aac', '-b:a', '192k', '-t', D.toFixed(3), '-movflags', '+faststart', '-f', 'mp4', `${out}.part`];
  const bitrate = W * CH > 4_000_000 ? '14M' : '8M';
  try { await run('ffmpeg', [...base, '-c:v', 'h264_videotoolbox', '-b:v', bitrate, ...tail], { timeout: 6 * 3600_000 }); }
  catch { await run('ffmpeg', [...base, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', ...tail], { timeout: 6 * 3600_000 }); }
  fs.renameSync(`${out}.part`, out);
  log(`canvas ${W}x${CH} · stacked ${merged.map((g) => `${g.a.toFixed(1)}-${g.b.toFixed(1)}s[${g.active.map((m) => m.file).join('+')}]`).join(' ')} → recording_all.mp4`);
  return merged.map((g) => ({ from: g.a, to: g.b, files: g.active.map((m) => m.file) }));
}

async function stepTranscribe() {
  current = 'transcript';
  setPart('transcript', { status: 'running', error: null });
  setJob({ status: 'running', step: '전사 중', progress: 0 });
  let last = 0;
  const segs = await transcribeSession(readSession(id), dir, {
    onProgress: (p) => { if (p - last >= 5) { last = p; setJob({ progress: p }); } },
  });
  setPart('transcript', { status: 'done', segments: segs.length, engine: 'whisper.cpp' });
  log(`transcribed ${segs.length} segments`);
}
async function stepCorrect() {
  current = 'transcript';
  setJob({ status: 'running', step: 'AI 교정 중', progress: 0 });
  const r = await correctSession(readSession(id), dir, { onProgress: (p) => setJob({ progress: p }) });
  setPart('transcript', { corrected: r.model, correctedLines: r.changed, newProposals: r.proposals });
  log(`corrected ${r.changed} lines, ${r.proposals} proposals`);
}
async function stepSummarize() {
  current = 'summary';
  setPart('summary', { status: 'running', error: null });
  setJob({ status: 'running', step: 'AI 요약 중', progress: null });
  const r = await summarizeSession(readSession(id), dir);
  setPart('summary', { status: 'done', provider: r.provider, model: r.model });
  const s = readSession(id);
  if (!s.title && r.title) updateSession(id, { title: r.title });
  log(`summarized by ${r.provider}/${r.model}`);
}

async function pipeline({ summarize }) {
  const cfg = loadConfig();
  const ai = providerStatus(cfg);
  await withLock(async () => {
    await stepTranscribe();
    if (ai.runnable && cfg.ai.llmCorrection) {
      try { current = 'transcript'; await stepCorrect(); }
      catch (e) { log('교정 실패(전사는 유지)', e.message); setPart('transcript', { status: 'done', correctError: e.message }); }
    }
    if (ai.runnable && summarize) await stepSummarize();
  });
}

async function main() {
  log('start', id);
  try {
    if (action === 'finalize') {
      const hasAudio = await finalize();
      const cfg = loadConfig();
      if (hasAudio && cfg.transcribe.auto && whisperStatus().ready) await pipeline({ summarize: cfg.ai.autoSummarize });
    } else if (action === 'pipeline') await pipeline({ summarize: argv.includes('--summarize') });
    else if (action === 'transcribe') await withLock(stepTranscribe);
    else if (action === 'correct') await withLock(stepCorrect);
    else if (action === 'summarize') await withLock(stepSummarize);
    else throw new Error(`알 수 없는 작업: ${action}`);
    const s = readSession(id);
    if (s.job?.status !== 'error') setJob({ status: 'done', step: null, progress: null, endedAt: new Date().toISOString(), error: null });
    log('done');
  } catch (e) {
    log('error', e.stack || e.message);
    if (current) setPart(current, { status: 'error', error: e.message });
    setJob({ status: 'error', error: e.message, endedAt: new Date().toISOString() });
    process.exitCode = 1;
  }
}
main();
