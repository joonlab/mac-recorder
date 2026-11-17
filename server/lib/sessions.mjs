// 녹화 세션 — 시작·정지·목록·삭제.
// 세션 하나 = 녹화 폴더 안의 하위 폴더 하나(<YYYYMMDD-HHMMSS>). 그 안의 session.json 이 유일한 상태 기록이다.
// Finder 에서 폴더를 지우면 목록에서도 사라진다(별도 색인 없음).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME, P, REPO, loadConfig, readJSON, writeJSON } from './config.mjs';
import { alive, run, sleep, stamp, moveToTrash } from './util.mjs';
import { dirBytes } from './media.mjs';

const ID_RE = /^\d{8}-\d{6}$/;
export const isId = (id) => typeof id === 'string' && ID_RE.test(id);

export function sessionDir(id) {
  if (!isId(id)) throw new Error('잘못된 녹화 ID');
  return path.join(loadConfig().recordingsDir, id);
}
export function readSession(id) {
  const s = readJSON(path.join(sessionDir(id), 'session.json'), null);
  if (!s) throw new Error(`녹화를 찾을 수 없습니다: ${id}`);
  return s;
}
export function updateSession(id, patch) {
  const file = path.join(sessionDir(id), 'session.json');
  const cur = readJSON(file, null);
  if (!cur) return null;
  const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch };
  writeJSON(file, next);
  return next;
}

// 폴더 안 파일로 재생·전사 상태를 계산한다(session.json 이 늦게 갱신돼도 실제 파일 기준으로 보이게)
export function describe(s) {
  const dir = sessionDir(s.id);
  const has = (f) => fs.existsSync(path.join(dir, f));
  const media = s.media && has(s.media) ? s.media : null;
  const base = media ? media.replace(/\.[^.]+$/, '') : null;
  const ext = media ? path.extname(media) : '';
  const stacked = has('recording_all.mp4') ? 'recording_all.mp4' : null;
  const mixed = base && has(`${base}_mixed${ext}`) ? `${base}_mixed${ext}` : null;
  // 재생 우선순위: 여러 화면 합본 → 마이크·시스템 소리 합친 파일 → 원본
  const play = stacked || mixed || media;
  return {
    ...s,
    dir,
    play,
    playKind: play ? (play.endsWith('.m4a') ? 'audio' : 'video') : null,
    hasTranscript: has('transcript.md'),
    hasSummary: has('summary.md'),
    bytes: dirBytes(dir),
  };
}

export function listSessions() {
  const root = loadConfig().recordingsDir;
  let names = [];
  try { names = fs.readdirSync(root).filter(isId); } catch { return []; }
  const out = [];
  for (const id of names.sort().reverse()) {
    const s = readJSON(path.join(root, id, 'session.json'), null);
    if (s) out.push(describe(s));
  }
  return out;
}

// ── 캡처 앱 ────────────────────────────────────────────────────────
function captureBin(cfg) { return path.join(cfg.captureApp, 'Contents/MacOS/MacRecorderCapture'); }

/** 캡처 앱을 `open -n` 으로 실행 — 권한이 node 가 아니라 캡처 앱에 붙게 하는 핵심. */
async function openCapture(cfg, args, logFile) {
  if (!fs.existsSync(captureBin(cfg))) throw new Error(`캡처 앱이 없습니다: ${cfg.captureApp} (install.sh 를 먼저 실행하세요)`);
  const openArgs = ['-n', '-g', cfg.captureApp];
  if (logFile) openArgs.push('--stdout', logFile, '--stderr', logFile);
  await run('open', [...openArgs, '--args', ...args], { timeout: 15000 });
}

/** 캡처 앱의 단발 모드(--list/--check/--request) 결과를 JSON 파일로 받는다. */
async function captureQuery(mode, timeoutMs = 10000) {
  const cfg = loadConfig();
  const out = path.join(P.jobs, `${mode.replace(/-/g, '')}-${process.pid}-${Date.now()}.json`);
  await openCapture(cfg, [mode, '--json-out', out]);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(out)) {
      await sleep(50);
      try { const j = JSON.parse(fs.readFileSync(out, 'utf8')); fs.rmSync(out, { force: true }); return j; } catch {}
    }
    await sleep(150);
  }
  throw new Error(`캡처 앱 응답 없음(${mode})`);
}

let devCache = { at: 0, value: null };
export async function devices({ fresh = false } = {}) {
  if (!fresh && devCache.value && Date.now() - devCache.at < 30000) return devCache.value;
  const v = await captureQuery('--list');
  devCache = { at: Date.now(), value: v };
  return v;
}
export const permissions = () => captureQuery('--check');
export const requestPermissions = () => captureQuery('--request', 180000);

// ── 진행 중 녹화 ───────────────────────────────────────────────────
export function getActive() {
  const a = readJSON(P.active, null);
  if (!a) return null;
  if (alive(a.pid)) {
    let cap = null;
    try { cap = JSON.parse(fs.readFileSync(path.join(sessionDir(a.id), 'capture.json'), 'utf8')); } catch {}
    return { ...a, state: cap?.state || 'starting', error: cap?.error || null, events: (cap?.events || []).filter((e) => e.type !== 'start').slice(-5) };
  }
  // 프로세스가 사라졌다 = 잠자기·오류·외부 종료로 끝남 → 마무리 잡을 띄우고 진행 중 표시를 지운다
  try { fs.rmSync(P.active, { force: true }); } catch {}
  try {
    const s = readSession(a.id);
    if (s.status === 'recording') {
      updateSession(a.id, { status: 'finishing', stoppedAt: new Date().toISOString() });
      spawnJob(a.id, 'finalize');
    }
  } catch {}
  return null;
}

export async function startRecording(opts = {}) {
  if (getActive()) throw new Error('이미 녹화 중입니다. 먼저 정지하세요.');
  const cfg = loadConfig();
  const r = { ...cfg.record, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined && v !== null)) };
  const video = !!r.video, mic = !!r.mic, system = !!r.system;
  if (!video && !mic && !system) throw new Error('화면·마이크·시스템 소리 중 하나 이상을 켜 주세요.');

  const id = stamp();
  const dir = path.join(cfg.recordingsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const media = video ? 'recording.mp4' : 'recording.m4a';
  const args = ['--out', path.join(dir, media), '--video', video ? '1' : '0', '--mic', mic ? '1' : '0',
    '--system', system ? '1' : '0', '--width', String(r.width || 0), '--fps', String(r.fps || 30),
    '--status-file', path.join(dir, 'capture.json'), '--mix-script', path.join(REPO, 'scripts', 'mix-audio.sh')];
  if (mic && r.micId) args.push('--mic-id', r.micId);

  // 화면 선택: «전체 화면»은 녹화 엔진이 직접 고른다(소리는 내장 화면에 싣고, 나머지 화면은 따로, 녹화 중 꽂은 화면도 추가).
  // 특정 화면이면 그 화면을 녹화하다가 빠지면 남은 화면으로 옮겨 이어 쓰고, 돌아오면 다시 돌아간다.
  if (video) {
    if (r.display && r.display !== 'all') args.push('--display-id', String(r.display));
    else args.push('--displays', 'all');
  }

  const session = {
    id, title: opts.title || '', createdAt: new Date().toISOString(), stoppedAt: null,
    sources: { video, mic, system }, display: video ? (r.display || 'all') : null, micId: mic ? (r.micId || '') : null,
    media, extras: [], status: 'recording',
    transcript: { status: 'none' }, summary: { status: 'none' },
  };
  writeJSON(path.join(dir, 'session.json'), session);
  await openCapture(cfg, args, path.join(dir, 'capture.log'));

  // 캡처 앱이 상태 파일에 pid·상태를 쓸 때까지 기다린다(권한 대화상자가 떠 있으면 더 걸릴 수 있다)
  const t0 = Date.now();
  let cap = null;
  while (Date.now() - t0 < 8000) {
    try { cap = JSON.parse(fs.readFileSync(path.join(dir, 'capture.json'), 'utf8')); } catch {}
    if (cap?.state === 'recording' || cap?.state === 'failed') break;
    await sleep(200);
  }
  if (!cap?.pid) {
    updateSession(id, { status: 'failed', error: '캡처 앱이 시작되지 않았습니다. capture.log 를 확인하세요.' });
    throw new Error('캡처 앱이 시작되지 않았습니다(권한 대화상자가 떠 있으면 허용 후 다시 시도).');
  }
  if (cap.state === 'failed') {
    updateSession(id, { status: 'failed', error: cap.error });
    // 아무것도 녹화되지 않은 빈 폴더는 남기지 않는다(목록이 실패 기록으로 어지러워짐)
    try { if (!fs.existsSync(path.join(dir, media))) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw new Error(cap.error || '녹화를 시작하지 못했습니다.');
  }
  writeJSON(P.active, { id, pid: cap.pid, startedAt: session.createdAt, sources: session.sources });
  return { id, pid: cap.pid, state: cap.state, sources: session.sources };
}

export function stopRecording() {
  const a = readJSON(P.active, null);
  if (!a) throw new Error('진행 중인 녹화가 없습니다.');
  try { process.kill(a.pid, 'SIGINT'); } catch {}
  try { fs.rmSync(P.active, { force: true }); } catch {}
  updateSession(a.id, { status: 'finishing', stoppedAt: new Date().toISOString() });
  spawnJob(a.id, 'finalize');
  return { id: a.id };
}

export async function deleteSession(id) {
  const a = readJSON(P.active, null);
  if (a?.id === id) throw new Error('녹화 중인 항목은 지울 수 없습니다.');
  const dir = sessionDir(id);
  if (!fs.existsSync(path.join(dir, 'session.json'))) throw new Error('녹화 폴더가 아닙니다.');
  await moveToTrash(dir);
  return { trashed: true };
}

export async function reveal(id, file) {
  const dir = sessionDir(id);
  const target = file ? safeFile(id, file) : dir;
  await run('open', file ? ['-R', target] : [target]);
}

/** 세션 폴더 안의 실재 파일만 허용(경로 탈출 방지). */
export function safeFile(id, name) {
  const dir = sessionDir(id);
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) throw new Error('잘못된 파일 이름');
  const f = path.join(dir, name);
  if (!fs.existsSync(f)) throw new Error('파일 없음');
  return f;
}

// ── 백그라운드 작업 ────────────────────────────────────────────────
// 전사·요약은 무겁다. 웹서버 안에서 돌리면 그동안 모든 요청이 멈추므로 별도 프로세스로 띄우고 바로 돌아온다.
export function spawnJob(id, action, extra = []) {
  const s = readSession(id);
  if (action !== 'finalize' && s.job?.status === 'running' && alive(s.job.pid)) {
    throw new Error('이미 처리 중입니다. 끝난 뒤 다시 시도하세요.');
  }
  // 상태를 먼저 «대기»로 써 둔다. 띄운 뒤에 쓰면 작업 프로세스가 먼저 쓴 «진행 중»을 덮어쓴다.
  updateSession(id, (cur) => ({ ...cur, job: { action, status: 'queued', startedAt: new Date().toISOString() } }));
  const log = fs.openSync(path.join(sessionDir(id), 'job.log'), 'a');
  const child = spawn(process.execPath, [path.join(REPO, 'server', 'job.mjs'), '--id', id, '--action', action, ...extra], {
    detached: true, stdio: ['ignore', log, log], env: { ...process.env, MACREC_HOME: HOME },
  });
  child.unref();
  updateSession(id, (cur) => ({ ...cur, job: { ...cur.job, pid: cur.job?.pid || child.pid } }));
  return { started: true, pid: child.pid };
}
