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
  // 3) 여러 화면 → 나란히 합본
  if ((s.extras || []).length) {
    setJob({ step: '여러 화면 합치는 중' });
    try { await run('/bin/bash', [path.join(REPO, 'scripts', 'stack-displays.sh'), dir], { timeout: 6 * 3600_000 }); }
    catch (e) { log('stack 실패', e.message); }
  }
  const info = await probe(media);
  updateSession(id, { status: 'ready', durationSec: Math.round(info.durationSec), audioTracks: info.audioTracks.length });
  log(`ready ${Math.round(info.durationSec)}s tracks=${info.audioTracks.length}`);
  return info.audioTracks.length > 0;
}

let current = null; // 실패 시 어느 항목에 오류를 적을지
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
