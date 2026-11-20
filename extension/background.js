// 서비스 워커 — 녹화 상태 보관·배지·탭 닫힘 감지만 한다.
// 실제 녹화(MediaRecorder)와 업로드는 offscreen 문서(offscreen.js)가 한다.
// 서비스 워커는 언제든 내려갔다 다시 뜰 수 있으므로 상태는 chrome.storage.session 에 둔다.
import { getSettings, health } from './common.js';

const OFFSCREEN = 'offscreen.html';

async function getRecs() { return (await chrome.storage.session.get({ recs: {} })).recs; }
async function setRecs(recs) { await chrome.storage.session.set({ recs }); }
async function patchRec(tabId, patch) {
  const recs = await getRecs();
  if (patch === null) delete recs[tabId];
  else recs[tabId] = { ...(recs[tabId] || {}), ...patch, tabId };
  await setRecs(recs);
  await badge(tabId, recs[tabId]);
  return recs;
}

async function badge(tabId, rec) {
  try {
    if (!rec || rec.state === 'stopping') {
      await chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }
    const paused = rec.state === 'paused';
    const err = rec.state === 'error';
    await chrome.action.setBadgeText({ tabId, text: err ? '!' : paused ? 'II' : 'REC' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: err ? '#b45309' : paused ? '#6b7280' : '#dc2626' });
    await chrome.action.setTitle({ tabId, title: err ? `녹화 오류: ${rec.error || ''}` : paused ? '일시정지 중' : '이 탭을 녹화하는 중' });
  } catch { /* 탭이 이미 닫혔으면 무시 */ }
}

/** 녹화 크기 = 탭 크기 × 화면 배율(폭 최대 1920). 탭 캡처는 max 크기에 맞춰 검은 띠를 씌우므로
 *  탭과 같은 비율의 정확한 크기를 준다(안 주면 1920×1920 같은 정사각형에 검은 띠, 2026-11-20 실측). */
function captureSize(tab, dpr) {
  const w = tab?.width || 1280, h = tab?.height || 720;
  const k = Math.min(Math.max(1, Number(dpr) || 1), 1920 / w, 1920 / h);
  const even = (x) => Math.max(2, Math.round(x / 2) * 2);
  return { width: even(w * k), height: even(h * k) };
}

let creating = null;
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  if (creating) return creating;
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ['USER_MEDIA'],
    justification: '탭 화면·소리와 마이크를 녹화합니다',
  }).finally(() => { creating = null; });
  return creating;
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

async function startTab({ tabId, title, url, source, dpr }) {
  const recs = await getRecs();
  if (recs[tabId] && recs[tabId].state !== 'error') throw new Error('이 탭은 이미 녹화 중입니다.');
  const st = await getSettings();
  if (!(await health(st.server))) throw new Error('MacRecorder 서버가 꺼져 있습니다.');
  // offscreen 문서를 먼저 만든다. 캡처 ID 를 받은 뒤에 만들면 offscreen 이 그 ID 를 열지 못한다
  // («Requested device not found», 2026-11-20 실측)
  await ensureOffscreen();
  let streamId = null;
  if (source !== 'synthetic') {
    // 팝업을 이 탭에서 열었으므로(activeTab) 서비스 워커가 그 탭의 캡처 ID 를 받을 수 있다
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  }
  await patchRec(tabId, { state: 'starting', title, url, startedAt: new Date().toISOString(), recordedSec: 0, error: null, mic: st.mic });
  const size = source === 'synthetic' ? null : captureSize(await chrome.tabs.get(tabId), dpr);
  const r = await toOffscreen({ type: 'start', tabId, streamId, title, url, mic: st.mic, micId: st.micId, server: st.server, source, size });
  if (!r?.ok) {
    await patchRec(tabId, null);
    throw new Error(r?.error || '녹화를 시작하지 못했습니다.');
  }
  return r;
}

async function closeOffscreenIfIdle() {
  const recs = await getRecs();
  if (Object.keys(recs).length) return;
  try { if (await chrome.offscreen.hasDocument?.()) await chrome.offscreen.closeDocument(); } catch {}
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.target === 'offscreen') return false; // offscreen 으로 가는 메시지
  (async () => {
    switch (msg?.type) {
      case 'start': return startTab(msg);
      case 'pause': case 'resume': case 'stop':
        return toOffscreen({ type: msg.type, tabId: msg.tabId });
      case 'list': return { recs: await getRecs() };
      case 'dismiss': await patchRec(msg.tabId, null); await closeOffscreenIfIdle(); return { ok: true };
      // offscreen → 서비스 워커
      case 'update': await patchRec(msg.tabId, msg.rec); return { ok: true };
      case 'removed': await patchRec(msg.tabId, null); await closeOffscreenIfIdle(); return { ok: true };
      default: return { ok: false, error: `알 수 없는 메시지 ${msg?.type}` };
    }
  })().then((r) => reply({ ok: true, ...(r || {}) }), (e) => reply({ ok: false, error: e.message }));
  return true;
});

// 녹화 중인 탭을 닫으면 그 녹화를 정지(지금까지 녹화한 것은 저장)
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const recs = await getRecs();
  if (!recs[tabId]) return;
  if (recs[tabId].state === 'error') { await patchRec(tabId, null); await closeOffscreenIfIdle(); return; }
  try { await toOffscreen({ type: 'stop', tabId, reason: 'tab-closed' }); } catch {}
});

// 페이지를 옮기면 탭별 배지가 지워진다 → 다시 붙인다
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const recs = await getRecs();
  if (recs[tabId]) badge(tabId, recs[tabId]);
});

// 브라우저를 다시 켰을 때 남은 기록은 의미가 없다(offscreen 문서도 사라졌다)
chrome.runtime.onStartup.addListener(() => chrome.storage.session.set({ recs: {} }));
