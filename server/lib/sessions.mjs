// 녹화 세션 — 시작·정지·목록·삭제.
// 세션 하나 = 녹화 폴더 안의 하위 폴더 하나. 그 안의 session.json 이 유일한 상태 기록이다.
// Finder 에서 폴더를 지우면 목록에서도 사라진다(별도 색인 없음).
// 녹화 ID 는 언제나 시작 시각(<YYYYMMDD-HHMMSS>)이고, 폴더 이름은 «파일 이름 규칙»(설정 naming.pattern)을 따른다
// (예: 20261118_1402_OO교육). 그래서 ID 로 폴더를 찾을 때는 session.json 의 id 를 본다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME, P, REPO, loadConfig, saveConfig, readJSON, writeJSON } from './config.mjs';
import { alive, run, sleep, stamp, pad, moveToTrash } from './util.mjs';
import { dirBytes } from './media.mjs';

const ID_RE = /^\d{8}-\d{6}$/;
export const isId = (id) => typeof id === 'string' && ID_RE.test(id);

// ID → 폴더 이름. 폴더 이름이 규칙대로 바뀌므로 녹화 폴더를 훑어 session.json 의 id 로 찾는다(찾을 때만 다시 훑음).
const dirCache = { root: '', map: new Map() };
function scanDirs(root) {
  dirCache.root = root; dirCache.map = new Map();
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch {}
  for (const n of names) {
    const sid = isId(n) ? n : readJSON(path.join(root, n, 'session.json'), null)?.id;
    if (isId(sid) && !dirCache.map.has(sid)) dirCache.map.set(sid, n);
  }
}
export function sessionDir(id) {
  if (!isId(id)) throw new Error('잘못된 녹화 ID');
  const root = loadConfig().recordingsDir;
  const ok = (n) => n && fs.existsSync(path.join(root, n, 'session.json'));
  if (dirCache.root === root && ok(dirCache.map.get(id))) return path.join(root, dirCache.map.get(id));
  if (ok(id)) return path.join(root, id);
  scanDirs(root);
  return path.join(root, dirCache.map.get(id) || id);
}
/** 새 녹화 ID. 같은 초에 두 개를 시작해도(창·탭 여러 개) 겹치지 않게 1초씩 민다. */
const issued = new Set();
export function newId() {
  const root = loadConfig().recordingsDir;
  scanDirs(root);
  let t = Date.now();
  for (;;) {
    const id = stamp(new Date(t));
    if (!issued.has(id) && !dirCache.map.has(id) && !fs.existsSync(path.join(root, id))) { issued.add(id); return id; }
    t += 1000;
  }
}

// ── 파일 이름 규칙 ─────────────────────────────────────────────────
// 토큰: {date}=20261118 {time}=1402 {hms}=140215 {title} {kind}=화면|창|탭 {sources}=화면+마이크 {app} {id}
// 값이 빈 토큰은 앞뒤 구분자와 함께 빠진다(제목이 없으면 «20261118_1402»).
export const DEFAULT_PATTERN = '{date}_{time}_{title}';
const KIND = { window: '창', tab: '탭' };
const clean = (v) => String(v || '').replace(/[\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/^\.+/, '').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
export function ruleName(s, pattern) {
  const d = isId(s.id) ? new Date(idTime(s.id)) : new Date(s.createdAt || Date.now());   // 날짜·시간은 녹화 ID(시작 시각) 기준
  const src = s.sources || {};
  const sources = [src.video && (KIND[s.kind] || '화면'), src.system && '소리', src.mic && '마이크'].filter(Boolean).join('+');
  const tok = {
    date: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
    time: `${pad(d.getHours())}${pad(d.getMinutes())}`,
    hms: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    title: clean(s.title), kind: KIND[s.kind] || '화면', sources, id: s.id,
    app: clean(s.window?.app || (s.tab ? '브라우저' : '')),
  };
  let out = String(pattern || DEFAULT_PATTERN).replace(/\{(\w+)\}/g, (_, k) => (k in tok ? tok[k] : `{${k}}`));
  out = out.replace(/([_\- ])[_\- ]+/g, '$1').replace(/^[_\- .]+|[_\- .]+$/g, '');
  out = clean(out).replace(/[{}]/g, '');
  return out || s.id;
}
export function folderNameFor(s) { return ruleName(s, loadConfig().naming?.pattern); }

/** 폴더 이름을 규칙대로 맞춘다. 녹화 중·처리 중이면 미뤄 두고(renamePending) 처리가 끝난 뒤 다시 부른다. */
export function applyNaming(id, { self = false } = {}) {
  const dir = sessionDir(id);
  const s = readJSON(path.join(dir, 'session.json'), null);
  if (!s) return { renamed: false };
  const busy = s.status === 'recording' || s.status === 'finishing' || isLive(id)
    || (!self && s.job && ['running', 'queued'].includes(s.job.status) && alive(s.job.pid));
  if (busy) { if (!s.renamePending) updateSession(id, { renamePending: true }); return { renamed: false, pending: true }; }
  const root = path.dirname(dir);
  const want = folderNameFor(s);
  if (path.basename(dir) === want || path.basename(dir).replace(/_\d+$/, '') === want) {
    if (s.renamePending) updateSession(id, { renamePending: false });
    return { renamed: false, name: path.basename(dir) };
  }
  let name = want, k = 2;
  while (fs.existsSync(path.join(root, name))) name = `${want}_${k++}`;
  fs.renameSync(dir, path.join(root, name));
  dirCache.map.set(id, name);
  updateSession(id, { renamePending: false });
  return { renamed: true, name };
}
export function applyNamingAll() {
  let renamed = 0, pending = 0;
  for (const s of listSessions()) {
    try { const r = applyNaming(s.id); if (r.renamed) renamed++; if (r.pending) pending++; } catch {}
  }
  return { renamed, pending };
}

/** 내려받기 파일 이름: 폴더 이름 + 파일 종류(예: «20261118_1402_OO교육.mp4», «…_전사.md») */
export function downloadName(id, file) {
  const dir = sessionDir(id);
  const base = path.basename(dir);
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  const has = (f) => fs.existsSync(path.join(dir, f));
  let suffix;
  if (stem === 'recording_all' || stem === 'recording_mixed') suffix = '';
  else if (stem === 'recording') suffix = has('recording_all.mp4') || has(`recording_mixed${ext}`) ? '_원본' : '';
  else if (stem === 'transcript') suffix = '_전사';
  else if (stem === 'summary') suffix = '_요약';
  else if (stem.startsWith('display-')) suffix = `_화면${stem.slice(7)}`;
  else suffix = `_${stem}`;
  return `${base}${suffix}${ext}`;
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
    folder: path.basename(dir),
    play,
    playKind: play ? (play.endsWith('.m4a') ? 'audio' : 'video') : null,
    hasTranscript: has('transcript.md'),
    hasSummary: has('summary.md'),
    bytes: dirBytes(dir),
  };
}

export function listSessions() {
  const root = loadConfig().recordingsDir;
  scanDirs(root);
  const out = [];
  for (const id of [...dirCache.map.keys()].sort().reverse()) {
    const s = readJSON(path.join(root, dirCache.map.get(id), 'session.json'), null);
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

// 화면·마이크 목록. 모니터를 꽂거나 빼면 displaysRev 가 올라가고, 대시보드는 그 값이 바뀌면 목록을 다시 읽는다.
let devCache = { at: 0, value: null };
let devSig = '';
export let displaysRev = 0;
let devInflight = null;
export async function devices({ fresh = false } = {}) {
  if (!fresh && devCache.value && Date.now() - devCache.at < 30000) return devCache.value;
  if (devInflight) return devInflight;
  devInflight = (async () => {
    try {
      const v = await captureQuery('--list');
      const sig = JSON.stringify((v.displays || []).map((d) => [d.id, d.width, d.height, d.main]))
        + JSON.stringify((v.mics || []).map((m) => m.id));
      if (sig !== devSig) { devSig = sig; displaysRev += 1; }
      devCache = { at: Date.now(), value: v };
      return v;
    } finally { devInflight = null; }
  })();
  return devInflight;
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
    // 진행 시간 = 지금까지 - 멈춰 있던 시간(일시정지 중이면 멈춘 순간까지)
    const now = Date.now();
    const pausedNow = cap?.paused && cap?.pausedSince ? now - new Date(cap.pausedSince).getTime() : 0;
    const recordedSec = Math.max(0, Math.round((now - new Date(a.startedAt).getTime() - pausedNow) / 1000 - (cap?.pausedTotalSec || 0)));
    return { ...a, state: cap?.state || 'starting', paused: !!cap?.paused, pauseReason: cap?.paused ? (cap?.pauseReason || 'manual') : null, recordedSec, error: cap?.error || null,
      events: (cap?.events || []).filter((e) => e.type !== 'start').slice(-5) };
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

  const id = newId();
  const dir = makeSessionDir(cfg, { id, title: opts.title || '', createdAt: new Date().toISOString(), sources: { video, mic, system } });
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
    id, title: opts.title || '', createdAt: idTime(id), stoppedAt: null,
    sources: { video, mic, system }, display: video ? (r.display || 'all') : null, micId: mic ? (r.micId || '') : null,
    media, extras: [], status: 'recording',
    transcript: { status: 'none' }, summary: { status: 'none' },
  };
  writeJSON(path.join(dir, 'session.json'), session);
  const cap = await launchAndWait(cfg, id, dir, args, media);
  writeJSON(P.active, { id, pid: cap.pid, startedAt: session.createdAt, sources: session.sources });
  return { id, pid: cap.pid, state: cap.state, sources: session.sources };
}

/** 녹화 엔진을 띄우고 상태 파일에 pid·상태를 쓸 때까지 기다린다(권한 대화상자가 떠 있으면 더 걸릴 수 있다) */
async function launchAndWait(cfg, id, dir, args, media) {
  await openCapture(cfg, args, path.join(dir, 'capture.log'));
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
  return cap;
}

/** ID(시작 시각)를 ISO 시각으로. 폴더 이름의 날짜·시간이 ID 와 같게. */
function idTime(id) {
  const m = id.match(/^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)$/);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toISOString();
}
/** 규칙 이름으로 새 녹화 폴더를 만든다 */
function makeSessionDir(cfg, s) {
  const want = ruleName({ ...s, createdAt: idTime(s.id) }, cfg.naming?.pattern);
  let name = want, k = 2;
  while (fs.existsSync(path.join(cfg.recordingsDir, name))) name = `${want}_${k++}`;
  const dir = path.join(cfg.recordingsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  dirCache.root = cfg.recordingsDir; dirCache.map.set(s.id, name);
  return dir;
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

/** 일시정지·다시 시작 — 녹화 엔진에 신호를 보낸다(SIGUSR1 = 일시정지, SIGUSR2 = 다시 시작) */
export function pauseRecording(want) {
  const a = getActive();
  if (!a) throw new Error('진행 중인 녹화가 없습니다.');
  const pause = want === undefined ? !a.paused : !!want;
  process.kill(a.pid, pause ? 'SIGUSR1' : 'SIGUSR2');
  return { id: a.id, paused: pause };
}

export async function deleteSession(id) {
  const a = readJSON(P.active, null);
  if (a?.id === id || isLive(id)) throw new Error('녹화 중인 항목은 지울 수 없습니다.');
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

// ── 창·탭 녹화: 여러 개를 동시에 ──────────────────────────────────
// 주 녹화(화면 전체·특정 화면)는 하나뿐이지만(active.json), 창 녹화·탭 녹화는 따로 여러 개 돌 수 있다.
// 진행 중인 것은 ~/.mac-recorder/live/<id>.json 에 하나씩 적는다.
//   창(window): 녹화 엔진을 창마다 하나씩 띄운다(open -n). 일시정지·정지는 신호로.
//   탭(tab):    크롬 확장이 녹화하고 조각을 서버로 올린다. 대시보드에서 누른 일시정지·정지는 확장이 다음 보고 때 받아 간다(cmd).
const LIVE_DIR = path.join(HOME, 'live');
const liveFile = (id) => path.join(LIVE_DIR, `${id}.json`);
const TAB_STALE_MS = 45000;   // 확장은 5초마다 보고한다. 이만큼 소식이 없으면 브라우저가 꺼진 것으로 보고 마무리
export const isLive = (id) => isId(id) && fs.existsSync(liveFile(id));
const readLive = (id) => readJSON(liveFile(id), null);
function writeLive(e) { fs.mkdirSync(LIVE_DIR, { recursive: true }); writeJSON(liveFile(e.id), e); }
function patchLive(id, patch) { const e = readLive(id); if (!e) return null; const n = { ...e, ...patch }; writeLive(n); return n; }

function finishLive(id, extra = {}) {
  try { fs.rmSync(liveFile(id), { force: true }); } catch {}
  try {
    const s = readSession(id);
    if (s.status === 'recording') {
      updateSession(id, { status: 'finishing', stoppedAt: new Date().toISOString(), ...extra });
      spawnJob(id, 'finalize');
    }
  } catch {}
}

/** 진행 중인 창·탭 녹화 목록(끝난 것은 여기서 마무리 작업을 띄운다) */
export function listLive() {
  let names = [];
  try { names = fs.readdirSync(LIVE_DIR).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const e = readJSON(path.join(LIVE_DIR, n), null);
    if (!e || !isId(e.id)) continue;
    if (e.kind === 'window') {
      if (!alive(e.pid)) { finishLive(e.id); continue; }
      let cap = null;
      try { cap = JSON.parse(fs.readFileSync(path.join(sessionDir(e.id), 'capture.json'), 'utf8')); } catch {}
      const now = Date.now();
      const pausedNow = cap?.paused && cap?.pausedSince ? now - new Date(cap.pausedSince).getTime() : 0;
      const recordedSec = Math.max(0, Math.round((now - new Date(e.startedAt).getTime() - pausedNow) / 1000 - (cap?.pausedTotalSec || 0)));
      out.push({ ...e, state: cap?.state || 'starting', paused: !!cap?.paused, pauseReason: cap?.paused ? (cap?.pauseReason || 'manual') : null,
        recordedSec, micName: cap?.micName || null, events: (cap?.events || []).filter((x) => x.type !== 'start').slice(-5) });
    } else if (e.kind === 'tab') {
      if (Date.now() - (e.lastSeen || 0) > TAB_STALE_MS) {
        finishLive(e.id, { captureEvents: [...(e.events || []), { type: 'tab-lost', at: new Date().toISOString(), detail: '브라우저와 연결이 끊겨 녹화를 마쳤습니다' }] });
        continue;
      }
      out.push({ ...e, state: 'recording' });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// 창 목록(녹화 엔진 --list-windows). 브라우저 창은 «맥 전체 소리»로 녹음해야 소리가 담긴다.
export async function listWindows() {
  const r = await captureQuery('--list-windows', 15000);
  if (!r.ok) throw new Error(r.error || '창 목록을 읽지 못했습니다');
  return r.windows;
}

/** 창 하나 녹화 시작. audio: app(그 앱 소리) | system(맥 전체 소리) | none. 생략하면 브라우저는 system, 나머지는 app */
export async function startWindowRecording(opts = {}) {
  const cfg = loadConfig();
  const wid = Number(opts.windowId);
  if (!wid) throw new Error('녹화할 창(windowId)이 필요합니다.');
  const w = (await listWindows()).find((x) => x.id === wid);
  if (!w) throw new Error('그 창을 찾을 수 없습니다(닫혔거나 목록을 새로고침해야 합니다).');
  if (listLive().some((e) => e.kind === 'window' && e.window?.id === wid)) throw new Error('이미 녹화 중인 창입니다.');
  const mic = opts.mic === undefined ? !!cfg.record.mic : !!opts.mic;
  const micId = opts.micId !== undefined ? opts.micId : cfg.record.micId;
  const audio = ['app', 'system', 'none'].includes(opts.audio) ? opts.audio : (w.browser ? 'system' : 'app');
  const id = newId();
  const title = String(opts.title || w.title || w.app).trim().slice(0, 120);
  const sources = { video: true, mic, system: audio !== 'none' };
  const dir = makeSessionDir(cfg, { id, title, sources, kind: 'window', window: w });
  const media = 'recording.mp4';
  const args = ['--out', path.join(dir, media), '--video', '1', '--mic', mic ? '1' : '0', '--system', audio !== 'none' ? '1' : '0',
    '--window-id', String(wid), '--window-audio', audio === 'system' ? 'system' : 'app',
    '--width', String(cfg.record.width || 0), '--fps', String(cfg.record.fps || 30),
    '--status-file', path.join(dir, 'capture.json'), '--mix-script', path.join(REPO, 'scripts', 'mix-audio.sh')];
  if (mic && micId) args.push('--mic-id', micId);
  const window = { id: wid, app: w.app, title: w.title, bundleId: w.bundleId, browser: !!w.browser, audio };
  const session = {
    id, kind: 'window', title, createdAt: idTime(id), stoppedAt: null, sources, window, micId: mic ? (micId || '') : null,
    media, extras: [], status: 'recording', transcript: { status: 'none' }, summary: { status: 'none' },
  };
  writeJSON(path.join(dir, 'session.json'), session);
  const cap = await launchAndWait(cfg, id, dir, args, media);
  writeLive({ id, kind: 'window', pid: cap.pid, startedAt: session.createdAt, title, window, sources });
  return { id, pid: cap.pid, window, audio };
}

// ── 탭 녹화(크롬 확장) ─────────────────────────────────────────────
export function startTabRecording(opts = {}) {
  const cfg = loadConfig();
  const id = newId();
  const title = String(opts.title || '브라우저 탭').trim().slice(0, 120);
  const sources = { video: true, mic: !!opts.mic, system: true };
  const tab = { url: String(opts.url || '').slice(0, 2000), title, mimeType: String(opts.mimeType || '') };
  const dir = makeSessionDir(cfg, { id, title, sources, kind: 'tab', tab });
  const session = {
    id, kind: 'tab', title, createdAt: idTime(id), stoppedAt: null, sources, tab,
    media: 'recording.mp4', extras: [], status: 'recording', transcript: { status: 'none' }, summary: { status: 'none' },
  };
  writeJSON(path.join(dir, 'session.json'), session);
  writeLive({ id, kind: 'tab', startedAt: session.createdAt, title, tab, sources, seq: -1, bytes: 0, lastSeen: Date.now(), paused: false, recordedSec: 0, cmd: null });
  return { id };
}
function tabEntry(id) {
  const e = isId(id) ? readLive(id) : null;
  if (!e || e.kind !== 'tab') { const err = new Error('진행 중인 탭 녹화가 아닙니다'); err.status = 404; throw err; }
  return e;
}
/** 조각 하나를 이어 붙인다. 같은 seq 를 다시 보내면(재시도) 무시한다. */
export async function appendTabChunk(id, seq, req) {
  const e = tabEntry(id);
  seq = Number(seq);
  const take = (cmd) => { if (cmd === 'pause' || cmd === 'resume') patchLive(id, { cmd: null }); return cmd || null; };
  if (!Number.isInteger(seq) || seq <= e.seq) { for await (const _ of req) {} return { ok: true, dup: true, cmd: take(e.cmd) }; }
  if (seq !== e.seq + 1) { for await (const _ of req) {} const err = new Error(`조각 순서가 맞지 않습니다(받을 차례 ${e.seq + 1}, 받은 것 ${seq})`); err.status = 409; throw err; }
  const file = path.join(sessionDir(id), 'tab.webm');
  const out = fs.createWriteStream(file, { flags: 'a' });
  let n = 0;
  await new Promise((resolve, reject) => {
    req.on('data', (c) => { n += c.length; if (!out.write(c)) { req.pause(); out.once('drain', () => req.resume()); } });
    req.on('end', () => out.end(resolve));
    req.on('error', reject); out.on('error', reject);
  });
  const next = patchLive(id, { seq, bytes: (e.bytes || 0) + n, lastSeen: Date.now() });
  return { ok: true, cmd: take(next.cmd) };
}
export function tabState(id, p = {}) {
  const e = tabEntry(id);
  const events = [...(e.events || [])];
  if (typeof p.paused === 'boolean' && p.paused !== e.paused) events.push({ type: p.paused ? 'paused' : 'resumed', at: new Date().toISOString() });
  const next = patchLive(id, { lastSeen: Date.now(), paused: typeof p.paused === 'boolean' ? p.paused : e.paused,
    pauseReason: p.paused ? 'manual' : null, recordedSec: Number(p.recordedSec) || e.recordedSec || 0, events });
  const cmd = next.cmd;
  if (cmd === 'pause' || cmd === 'resume') patchLive(id, { cmd: null });
  return { ok: true, cmd: cmd || null };
}
export function stopTab(id, p = {}) {
  tabEntry(id);
  const events = Array.isArray(p.events) ? p.events.slice(0, 500).map((x) => ({ type: String(x.type || ''), at: String(x.at || ''), ...(typeof x.t === 'number' ? { t: x.t } : {}) })) : [];
  finishLive(id, { captureEvents: events, pausedTotalSec: Number(p.pausedTotalSec) || 0, stopReason: String(p.reason || 'user').slice(0, 20) });
  return { ok: true, id };
}

/** 대시보드·메뉴바·macrec 에서 창·탭 녹화 정지·일시정지 */
export function controlLive(id, action, want) {
  const e = isId(id) ? readLive(id) : null;
  if (!e) {
    let done = false; try { done = !!readSession(id); } catch {}
    throw new Error(done ? '이미 끝난 녹화입니다(창·탭을 닫으면 그 녹화는 저절로 끝납니다).' : '진행 중인 녹화가 없습니다.');
  }
  if (e.kind === 'window') {
    if (action === 'stop') { try { process.kill(e.pid, 'SIGINT'); } catch {} finishLive(id); return { id, stopped: true }; }
    let paused = false;
    try { paused = !!JSON.parse(fs.readFileSync(path.join(sessionDir(id), 'capture.json'), 'utf8')).paused; } catch {}
    const pause = want === undefined ? !paused : !!want;
    process.kill(e.pid, pause ? 'SIGUSR1' : 'SIGUSR2');
    return { id, paused: pause };
  }
  // 탭: 확장이 다음 보고(5초 안)에 받아 간다
  if (action === 'stop') { patchLive(id, { cmd: 'stop' }); return { id, stopping: true }; }
  const pause = want === undefined ? !e.paused : !!want;
  patchLive(id, { cmd: pause ? 'pause' : 'resume' });
  return { id, paused: pause, pending: true };
}

// ── 녹화 폴더 바꾸기 ───────────────────────────────────────────────
/** 백그라운드 서버가 읽기 어려운 폴더(macOS 보호 폴더)·동기화 폴더면 주의 문구 */
export function folderWarnings(dir) {
  const h = os.homedir();
  const w = [];
  if ([`${h}/Desktop`, `${h}/Documents`, `${h}/Downloads`].some((p) => dir === p || dir.startsWith(`${p}/`))) {
    w.push('바탕화면·문서·다운로드 폴더는 macOS 가 보호하는 곳이라, 백그라운드 서버가 접근을 거절하거나 권한 창을 띄울 수 있습니다.');
  }
  if (/\/Library\/Mobile Documents\/|\/Library\/CloudStorage\/|OneDrive|Dropbox|Google Drive/i.test(dir)) {
    w.push('iCloud·OneDrive·Dropbox·Google Drive 같은 동기화 폴더는 녹화 중 큰 파일을 계속 올리려 해서 느려지거나 충돌 사본이 생길 수 있습니다.');
  }
  return w;
}
/** 녹화 폴더를 바꾼다. move 가 true 면 지금 폴더의 녹화도 옮긴다(옮기지 않으면 대시보드 목록에서 안 보인다). */
export async function changeRecordingsDir(target, { move = false } = {}) {
  let dir = String(target || '').trim().replace(/^~(?=\/|$)/, os.homedir());
  if (!path.isAbsolute(dir)) throw new Error('폴더는 절대경로로 적어 주세요(예: ~/Movies/MacRecorder).');
  dir = path.resolve(dir);
  const cur = loadConfig().recordingsDir;
  if (dir === cur) return { recordingsDir: dir, moved: 0, warnings: folderWarnings(dir) };
  if (dir.startsWith(`${cur}/`)) throw new Error('지금 녹화 폴더 안의 폴더로는 바꿀 수 없습니다.');
  if (getActive() || listLive().length) throw new Error('녹화 중에는 폴더를 바꿀 수 없습니다. 녹화를 멈춘 뒤 다시 시도하세요.');
  const busy = listSessions().filter((s) => s.job && ['running', 'queued'].includes(s.job.status) && alive(s.job.pid));
  if (move && busy.length) throw new Error(`처리 중인 녹화가 ${busy.length}개 있습니다. 전사·요약이 끝난 뒤 옮기세요.`);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.accessSync(dir, fs.constants.W_OK); } catch { throw new Error(`그 폴더에 쓸 수 없습니다: ${dir}`); }
  let moved = 0;
  const failed = [];
  if (move) {
    scanDirs(cur);
    for (const name of dirCache.map.values()) {
      const src = path.join(cur, name);
      let dst = path.join(dir, name), k = 2;
      while (fs.existsSync(dst)) dst = path.join(dir, `${name}_${k++}`);
      try { fs.renameSync(src, dst); moved++; }
      catch (e) {
        if (e.code !== 'EXDEV') { failed.push(name); continue; }
        // 다른 디스크로: 복사한 뒤 원본은 휴지통으로(바로 지우지 않는다)
        try { await run('ditto', [src, dst], { timeout: 6 * 3600_000 }); await moveToTrash(src); moved++; } catch { failed.push(name); }
      }
    }
  }
  saveConfig({ recordingsDir: dir });
  scanDirs(dir);
  return { recordingsDir: dir, moved, failed, warnings: folderWarnings(dir) };
}

/** Finder 폴더 고르기 창(서버가 osascript 로 띄운다) */
export async function pickFolder() {
  const cur = loadConfig().recordingsDir.replace(/"/g, '\\"');
  try {
    const { stdout } = await run('osascript', ['-e', `POSIX path of (choose folder with prompt "녹화를 저장할 폴더를 고르세요" default location (POSIX file "${cur}"))`], { timeout: 300000 });
    return { path: stdout.trim().replace(/\/$/, '') };
  } catch { return { path: null, cancelled: true }; }
}
