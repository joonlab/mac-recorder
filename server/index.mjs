#!/usr/bin/env node
// MacRecorder 서버 — 녹화 제어 API + 대시보드. 메뉴바 앱·CLI·Raycast 가 모두 이 API 를 쓴다.
// 기본은 127.0.0.1 에만 열린다(같은 Wi-Fi 의 다른 사람이 접근하지 못하게).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HOME, P, REPO, VERSION, ensureHome, loadConfig, saveConfig, loadSecrets, saveSecrets, mask } from './lib/config.mjs';
import * as S from './lib/sessions.mjs';
import { serveFile } from './lib/media.mjs';
import { whisperStatus, readSegments, writeTranscript } from './lib/transcribe.mjs';
import { providerStatus, complete, findClaudeCli } from './lib/llm.mjs';
import { claudeCodePrompt, promptTemplate } from './lib/ai.mjs';
import * as G from './lib/glossary.mjs';

ensureHome();
const cfg0 = loadConfig();
fs.mkdirSync(cfg0.recordingsDir, { recursive: true });
const PUBLIC = path.join(REPO, 'public');

// ── 보안: 브라우저의 다른 사이트가 이 서버를 조작하지 못하게 ─────────
function hostAllowed(req, cfg) {
  if (cfg.host === '0.0.0.0') return true;
  const h = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  const local = ['127.0.0.1', 'localhost', '::1', os.hostname().toLowerCase(), os.hostname().toLowerCase().replace(/\.local$/, '')];
  if (local.includes(h)) return true;
  return (cfg.allowedHosts || []).some((p) => {
    p = String(p).toLowerCase();
    return p.startsWith('*.') ? h.endsWith(p.slice(1)) : h === p;
  });
}
// 상태를 바꾸는 POST 는 JSON 으로만 받는다 → 다른 사이트의 폼·단순 요청은 CORS 사전 검사에 막힌다
function writeAllowed(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  return /application\/json/.test(req.headers['content-type'] || '') || req.headers['x-macrec'] === '1';
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
async function body(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 20 * 1024 * 1024) throw new Error('요청이 너무 큽니다'); }
  return s ? JSON.parse(s) : {};
}

function publicConfig(cfg) {
  const sec = loadSecrets();
  return {
    ...cfg,
    secrets: {
      openaiKey: mask(sec.openaiKey), anthropicKey: mask(sec.anthropicKey),
      openaiFromEnv: sec.fromEnv.openai, anthropicFromEnv: sec.fromEnv.anthropic,
    },
    claudeCli: findClaudeCli(),
  };
}

function status() {
  const cfg = loadConfig();
  const active = S.getActive();
  let elapsed = 0;
  if (active) elapsed = (Date.now() - new Date(active.startedAt).getTime()) / 1000;
  return {
    ok: true, version: VERSION, now: new Date().toISOString(),
    active: active ? { ...active, elapsedSec: active.recordedSec ?? Math.round(elapsed) } : null,
    live: S.listLive(),
    record: cfg.record,
    whisper: whisperStatus(),
    ai: providerStatus(cfg),
    recordingsDir: cfg.recordingsDir,
    proposals: G.loadProposals().length,
    displaysRev: S.displaysRev,
    port: cfg.port,
    menubar: menubarState(cfg),
  };
}

// ── 메뉴바 앱 ───────────────────────────────────────────────────
// 메뉴바 앱이 꺼지면 아이콘과 단축키(⌃⌥⌘R·⌃⌥⌘P)가 함께 꺼진다. 대시보드는 이 상태를 보고 «다시 띄우기»를 보여 준다.
const STARTED = Date.now();
const menubar = { seenAt: 0, iconHidden: false, cmd: null };
const menubarApp = (cfg) => path.join(path.dirname(cfg.captureApp), 'MacRecorder.app');
function menubarState(cfg) {
  let expected = true;   // 설치할 때 --no-menubar 를 줬으면 꺼져 있어도 알리지 않는다
  try { expected = JSON.parse(fs.readFileSync(path.join(HOME, 'install.json'), 'utf8')).options?.menubar !== false; } catch {}
  const running = Date.now() - menubar.seenAt < 5000;
  return {
    installed: fs.existsSync(menubarApp(cfg)), expected,
    // 서버가 막 켜졌으면 메뉴바 앱이 아직 못 불렀을 수 있다 → 모름(null)
    running: running ? true : Date.now() - STARTED < 8000 ? null : false,
    iconHidden: running ? menubar.iconHidden : false,
    app: menubarApp(cfg),
  };
}
async function menubarAction(action) {
  const cfg = loadConfig();
  const st = menubarState(cfg);
  if (action === 'hide') {
    if (!st.running) throw new Error('메뉴바 앱이 꺼져 있습니다.');
    menubar.cmd = 'hide';
    return { how: 'signal' };
  }
  if (st.running) { menubar.cmd = 'show'; return { how: 'signal' }; }
  if (!st.installed) throw new Error(`메뉴바 앱이 없습니다: ${st.app} (install.sh 를 다시 실행하세요)`);
  const { run } = await import('./lib/util.mjs');
  // -g: 다른 창 앞으로 튀어나오지 않게. --show: 아이콘을 숨긴 채 꺼졌어도 보이게 켠다
  const env = HOME !== path.join(os.homedir(), '.mac-recorder') ? ['--env', `MACREC_HOME=${HOME}`] : [];
  await run('open', ['-g', ...env, st.app, '--args', '--show'], { timeout: 15000 });
  return { how: 'launched' };
}

const ALLOWED_CONFIG = ['record', 'transcribe', 'ai', 'context', 'allowedHosts', 'naming'];

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // ['sessions', id, ...]
  const m = req.method;
  const [a, b, c, d] = parts;

  if (a === 'status' && m === 'GET') {
    // 메뉴바 앱은 1초마다 ?menubar=1&icon=0|1 로 부른다 → 살아 있는지·아이콘을 숨겼는지 안다. 서버가 보낼 명령(show·hide)은 menubarCmd 로 받아 간다
    if (url.searchParams.get('menubar') === '1') {
      menubar.seenAt = Date.now(); menubar.iconHidden = url.searchParams.get('icon') === '0';
      const cmd = menubar.cmd; menubar.cmd = null;
      return json(res, 200, { ...status(), menubarCmd: cmd });
    }
    return json(res, 200, status());
  }
  if (a === 'menubar' && m === 'POST') return json(res, 200, { ok: true, ...(await menubarAction((await body(req)).action || 'show')) });
  if (a === 'devices' && m === 'GET') return json(res, 200, { ...(await S.devices({ fresh: url.searchParams.get('fresh') === '1' })), rev: S.displaysRev });
  if (a === 'displays-changed' && m === 'POST') {
    // 메뉴바 앱이 macOS 화면 구성 변경 알림을 받으면 부른다 → 목록을 새로 읽어 displaysRev 를 올린다
    const before = S.displaysRev;
    await S.devices({ fresh: true });
    // 막 연결된 모니터는 목록에 조금 늦게 잡힌다 → 그대로면 잠시 뒤 두 번 더 확인
    if (S.displaysRev === before) for (const ms of [1500, 3500]) setTimeout(() => { S.devices({ fresh: true }).catch(() => {}); }, ms);
    return json(res, 200, { ok: true, rev: S.displaysRev });
  }
  if (a === 'permissions' && m === 'GET') return json(res, 200, await S.permissions());
  if (a === 'permissions' && b === 'request' && m === 'POST') return json(res, 200, await S.requestPermissions());
  if (a === 'permissions' && b === 'open-settings' && m === 'POST') {
    const pane = (await body(req)).pane === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture';
    const { run } = await import('./lib/util.mjs');
    await run('open', [`x-apple.systempreferences:com.apple.preference.security?${pane}`]);
    return json(res, 200, { ok: true });
  }

  if (a === 'start' && m === 'POST') return json(res, 200, { ok: true, ...(await S.startRecording(await body(req))) });
  if (a === 'stop' && m === 'POST') return json(res, 200, { ok: true, ...S.stopRecording() });
  if (a === 'pause' && m === 'POST') {
    // body.paused: true=일시정지, false=다시 시작, 없으면 전환
    const p = await body(req);
    return json(res, 200, { ok: true, ...S.pauseRecording(p.paused) });
  }
  if (a === 'toggle' && m === 'POST') {
    if (S.getActive()) return json(res, 200, { ok: true, action: 'stopped', ...S.stopRecording() });
    return json(res, 200, { ok: true, action: 'started', ...(await S.startRecording(await body(req))) });
  }

  // 창 녹화(여러 개 동시) — 녹화 엔진을 창마다 하나씩
  if (a === 'windows' && !b && m === 'GET') return json(res, 200, { windows: await S.listWindows() });
  if (a === 'windows' && b === 'start' && m === 'POST') return json(res, 200, { ok: true, ...(await S.startWindowRecording(await body(req))) });
  // 진행 중인 창·탭 녹화
  if (a === 'live' && !b && m === 'GET') return json(res, 200, { live: S.listLive() });
  if (a === 'live' && b && (c === 'stop' || c === 'pause') && m === 'POST') {
    const p = await body(req);
    return json(res, 200, { ok: true, ...S.controlLive(b, c, c === 'pause' ? p.paused : undefined) });
  }
  // 탭 녹화(크롬 확장) — 확장이 녹화 조각을 올린다
  if (a === 'tabs') {
    if (b === 'start' && m === 'POST') return json(res, 200, { ok: true, ...S.startTabRecording(await body(req)) });
    if (b && c === 'chunk' && m === 'POST') return json(res, 200, await S.appendTabChunk(b, url.searchParams.get('seq'), req));
    if (b && c === 'state' && m === 'POST') return json(res, 200, S.tabState(b, await body(req)));
    if (b && c === 'stop' && m === 'POST') return json(res, 200, S.stopTab(b, await body(req)));
  }
  // 파일 이름 규칙
  if (a === 'naming' && b === 'preview' && m === 'GET') {
    const pattern = url.searchParams.get('pattern') || loadConfig().naming?.pattern;
    const sample = { id: '20261118-140215', createdAt: new Date(2026, 10, 18, 14, 2, 15).toISOString(), title: 'OO교육', sources: { video: true, mic: true, system: true } };
    return json(res, 200, { pattern, sample: S.ruleName(sample, pattern), untitled: S.ruleName({ ...sample, title: '' }, pattern) });
  }
  if (a === 'naming' && b === 'apply' && m === 'POST') return json(res, 200, { ok: true, ...S.applyNamingAll() });
  // 녹화 폴더 바꾸기
  if (a === 'recordings-dir' && !b && m === 'POST') {
    const p = await body(req);
    return json(res, 200, { ok: true, ...(await S.changeRecordingsDir(p.path, { move: !!p.move })) });
  }
  if (a === 'recordings-dir' && b === 'pick' && m === 'POST') return json(res, 200, await S.pickFolder());
  if (a === 'recordings-dir' && b === 'check' && m === 'GET') {
    const p = String(url.searchParams.get('path') || '').replace(/^~(?=\/|$)/, os.homedir());
    return json(res, 200, { path: p, warnings: S.folderWarnings(p), exists: fs.existsSync(p), count: S.listSessions().length });
  }

  if (a === 'sessions') {
    if (!b && m === 'GET') return json(res, 200, { sessions: S.listSessions() });
    if (b && !S.isId(b)) return json(res, 400, { error: '잘못된 녹화 ID' });
    const dir = b ? S.sessionDir(b) : null;
    if (b && !c && m === 'GET') {
      const s = S.describe(S.readSession(b));
      let summary = null;
      try { summary = fs.readFileSync(path.join(dir, S.resolveFile(dir, s, 'summary.md')), 'utf8'); } catch {}
      const tj = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8')); } catch { return null; } })();
      return json(res, 200, { session: s, transcript: tj, summary, claudeCodePrompt: claudeCodePrompt(s, dir) });
    }
    if (b && !c && m === 'PATCH') {
      const p = await body(req);
      // 대시보드에서 제목을 고치면 Finder 에서 직접 정한 폴더 이름(nameLocked)도 풀고 규칙 이름으로 맞춘다
      const prev = S.readSession(b);
      let next;
      try {
        next = S.updateSession(b, (cur) => ({ ...cur, ...(typeof p.title === 'string' ? { title: p.title.trim().slice(0, 120), nameLocked: undefined } : {}), ...(typeof p.note === 'string' ? { note: p.note } : {}) }));
      } catch (e) { return json(res, 409, { error: `이름을 바꾸지 못했습니다(녹화 폴더에 쓸 수 없음): ${e.code || e.message}` }); }
      // 제목이 바뀌면 폴더(·파일) 이름도 규칙대로(녹화·처리 중이면 끝난 뒤).
      // 실패하면 폴더·파일 이름은 applyNaming 이 되돌리고, 여기서 제목도 원래대로 돌린 뒤 error 를 돌려준다
      let naming = null;
      if (typeof p.title === 'string') {
        try { naming = S.applyNaming(b); }
        catch (e) { naming = { error: e.message }; try { S.updateSession(b, { title: prev.title, nameLocked: prev.nameLocked }); } catch {} }
      }
      try { next = S.describe(S.readSession(b)); } catch {}
      return json(res, 200, { ok: true, session: next, naming });
    }
    if (b && !c && m === 'DELETE') return json(res, 200, { ok: true, ...(await S.deleteSession(b)) });
    if (c === 'file' && d && (m === 'GET' || m === 'HEAD')) {
      const name = decodeURIComponent(d);
      return serveFile(req, res, S.safeFile(b, name), { download: url.searchParams.get('download') === '1', downloadName: S.downloadName(b, name) });
    }
    if (c === 'reveal' && m === 'POST') { await S.reveal(b, (await body(req)).file); return json(res, 200, { ok: true }); }
    if (['transcribe', 'pipeline', 'correct', 'summarize'].includes(c) && m === 'POST') {
      const p = await body(req);
      if (c !== 'transcribe' && c !== 'pipeline' && !providerStatus().runnable) return json(res, 400, { error: providerStatus().reason });
      if ((c === 'transcribe' || c === 'pipeline') && !whisperStatus().ready) return json(res, 400, { error: 'whisper 가 설치되지 않았습니다(./install.sh --with-transcribe)' });
      return json(res, 200, { ok: true, ...S.spawnJob(b, c, p.summarize ? ['--summarize'] : []) });
    }
    if (c === 'transcript' && m === 'PUT') {
      // 사용자가 대시보드에서 고친 전사 저장 + 고친 부분에서 «A→B» 를 뽑아 교정 제안으로
      const p = await body(req);
      S.toCanonical(b);   // 고정 이름(transcript.md …)으로 되돌린 뒤 쓰고, 다 쓰면 다시 폴더 이름에 맞춘다
      const segs = readSegments(dir);
      const pairs = [];
      for (const e of p.edits || []) {
        const i = Number(e.i);
        if (!segs[i] || typeof e.text !== 'string') continue;
        pairs.push(...G.diffPairs(segs[i].text, e.text));
        segs[i] = { ...segs[i], text: e.text.trim() };
      }
      writeTranscript(dir, S.readSession(b), segs, { editedAt: new Date().toISOString() });
      try { S.applyNaming(b); } catch {}
      const added = pairs.length ? G.addProposals(pairs, 'edit', b) : 0;
      return json(res, 200, { ok: true, proposals: added, pairs });
    }
    if (c === 'summary' && m === 'PUT') {
      const text = String((await body(req)).text || '');
      S.toCanonical(b);
      fs.writeFileSync(path.join(dir, 'summary.md'), text);
      S.updateSession(b, (cur) => ({ ...cur, summary: { ...(cur.summary || {}), status: 'done', provider: cur.summary?.provider || 'manual', updatedAt: new Date().toISOString() } }));
      try { S.applyNaming(b); } catch {}
      return json(res, 200, { ok: true });
    }
  }

  if (a === 'glossary') {
    if (m === 'GET') return json(res, 200, G.loadGlossary());
    if (m === 'PUT') return json(res, 200, G.saveGlossary(await body(req)));
  }
  if (a === 'proposals') {
    if (!b && m === 'GET') return json(res, 200, { proposals: G.loadProposals() });
    if (!b && m === 'POST') {
      const p = await body(req);
      return json(res, 200, { ok: true, added: G.addProposals(p.pairs || [{ from: p.from, to: p.to }], p.source || 'manual', p.sessionId) });
    }
    if (b === 'resolve' && m === 'POST') return json(res, 200, { ok: true, glossary: G.resolveProposal(await body(req)) });
  }

  if (a === 'config') {
    if (m === 'GET') return json(res, 200, publicConfig(loadConfig()));
    if (m === 'PUT') {
      const p = await body(req);
      const patch = Object.fromEntries(Object.entries(p).filter(([k]) => ALLOWED_CONFIG.includes(k)));
      return json(res, 200, publicConfig(saveConfig(patch)));
    }
  }
  if (a === 'secrets' && m === 'PUT') {
    const p = await body(req);
    saveSecrets({ ...(p.openaiKey !== undefined ? { openaiKey: p.openaiKey } : {}), ...(p.anthropicKey !== undefined ? { anthropicKey: p.anthropicKey } : {}) });
    return json(res, 200, publicConfig(loadConfig()));
  }
  if (a === 'prompts' && ['summary', 'correct'].includes(b)) {
    const f = path.join(P.prompts, `${b}.md`);
    if (m === 'GET') return json(res, 200, { text: promptTemplate(b), custom: fs.existsSync(f) });
    if (m === 'PUT') { fs.writeFileSync(f, String((await body(req)).text || '')); return json(res, 200, { ok: true }); }
    if (m === 'DELETE') { fs.rmSync(f, { force: true }); return json(res, 200, { ok: true, text: promptTemplate(b) }); }
  }
  if (a === 'ai' && b === 'test' && m === 'POST') {
    const t0 = Date.now();
    const r = await complete({ system: '짧게 답하세요.', prompt: '연결 확인입니다. «연결됨» 한 단어로만 답하세요.', maxTokens: 1000 });
    return json(res, 200, { ok: true, reply: r.text.slice(0, 200), model: r.model, provider: r.provider, ms: Date.now() - t0 });
  }
  if (a === 'open' && m === 'POST') {
    const what = (await body(req)).what;
    const { run } = await import('./lib/util.mjs');
    if (what === 'recordings') await run('open', [loadConfig().recordingsDir]);
    else if (what === 'settings-folder') await run('open', [P.config.replace(/\/config\.json$/, '')]);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: `없는 API: ${m} ${url.pathname}` });
}

const server = http.createServer(async (req, res) => {
  const cfg = loadConfig();
  if (!hostAllowed(req, cfg)) { res.writeHead(403); return res.end('host not allowed'); }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, version: VERSION });
    if (url.pathname.startsWith('/api/')) {
      if (!writeAllowed(req)) return json(res, 415, { error: 'Content-Type: application/json 필요' });
      return await api(req, res, url);
    }
    // 정적 파일 (대시보드)
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const f = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    return serveFile(req, res, f);
  } catch (e) {
    const code = e.status || (/없습니다|없음|잘못|필요|켜 주세요|이미|지울 수|아닙니다|바꿀 수|쓸 수 없|적어 주세요|옮기세요/.test(e.message) ? 400 : 500);
    if (code === 500) console.error(new Date().toISOString(), req.method, req.url, e.stack || e);
    return json(res, code, { error: e.message });
  }
});

server.listen(cfg0.port, cfg0.host, () => {
  console.log(`[mac-recorder] v${VERSION} http://${cfg0.host === '0.0.0.0' ? 'localhost' : cfg0.host}:${cfg0.port}  녹화 폴더: ${cfg0.recordingsDir}`);
});
server.on('error', (e) => { console.error('[mac-recorder] 서버 시작 실패:', e.message); process.exit(1); });
// 서버가 재시작되면 진행 중 녹화 상태를 한 번 점검(끊긴 녹화 마무리)
setTimeout(() => { try { S.getActive(); } catch {} }, 1000);
