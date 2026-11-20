// 팝업 — 지금 탭 녹화 시작·일시정지·정지, 녹화 중인 다른 탭 목록, 마이크·포트 설정
import { DEFAULT_PORT, getSettings, health } from './common.js';

const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg);
const fmt = (sec) => { sec = Math.max(0, Math.round(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60; return (h ? `${h}:` : '') + `${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`; };
const STATE = { starting: '시작하는 중', recording: '녹화 중', paused: '일시정지', stopping: '저장하는 중', error: '오류' };

let tab = null;
let settings = null;
let serverOk = false;

function showErr(msg) { const e = $('#err'); e.textContent = msg || ''; e.hidden = !msg; }

function capturable(t) {
  return t && t.url !== undefined ? !/^(chrome|edge|brave|arc|about|chrome-extension|devtools|view-source):/i.test(t.url || '') : true;
}

async function micPermission() {
  try { return (await navigator.permissions.query({ name: 'microphone' })).state; } catch { return 'prompt'; }
}

async function fillMics() {
  const perm = await micPermission();
  const sel = $('#micSel');
  let mics = [];
  if (perm === 'granted') {
    try { mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'); } catch {}
  }
  sel.innerHTML = '<option value="">시스템 기본</option>' + mics.map((d) => `<option value="${d.deviceId}">${escapeHtml(d.label || '이름 없는 마이크')}</option>`).join('');
  if (settings.micId && !mics.some((d) => d.deviceId === settings.micId) && perm === 'granted') {
    sel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(settings.micId)}">선택했던 마이크 (연결 안 됨)</option>`);
  }
  sel.value = settings.micId || '';
  $('#micPerm').hidden = perm === 'granted' || !$('#mic').checked;
  $('#micRow').hidden = !$('#mic').checked;
  return perm;
}

function hostOf(u) { try { return new URL(u).host; } catch { return ''; } }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function openPermissionPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
}

async function render() {
  const { recs = {} } = await send({ type: 'list' });
  const mine = tab ? recs[tab.id] : null;
  $('#curTitle').textContent = tab?.title || hostOf(tab?.url) || '이 탭';
  $('#curIdle').hidden = !!mine && mine.state !== 'error';
  $('#curRec').hidden = !mine || mine.state === 'error';
  const ok = serverOk && capturable(tab);
  $('#startBtn').disabled = !ok;
  $('#curNote').textContent = serverOk && !capturable(tab) ? '브라우저 설정·확장 페이지는 녹화할 수 없습니다.' : '';
  if (mine && mine.state !== 'error') {
    $('#curRec').classList.toggle('paused', mine.state === 'paused');
    $('#curState').textContent = STATE[mine.state] || mine.state;
    $('#curTime').textContent = fmt(mine.recordedSec) + (mine.uploadDelay ? ' · 서버에 올리는 중 지연' : '');
    $('#pauseBtn').textContent = mine.state === 'paused' ? '다시 녹화' : '일시정지';
    $('#pauseBtn').disabled = !['recording', 'paused'].includes(mine.state);
    $('#stopBtn').disabled = mine.state === 'stopping' || mine.state === 'starting';
  }
  if (mine?.state === 'error') showErr(mine.error);

  const others = Object.values(recs).filter((r) => !tab || r.tabId !== tab.id);
  $('#others').hidden = !others.length;
  $('#list').innerHTML = '';
  for (const r of others) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 't';
    t.title = '이 탭으로 이동';
    t.textContent = `${r.state === 'error' ? '⚠︎ ' : r.state === 'paused' ? '⏸ ' : '● '}${r.title || '탭'} ${r.state === 'error' ? '' : fmt(r.recordedSec)}`;
    t.onclick = () => chrome.tabs.update(r.tabId, { active: true });
    li.append(t);
    if (r.state === 'error') {
      li.title = r.error || '';
      const b = document.createElement('button'); b.textContent = '닫기'; b.onclick = () => send({ type: 'dismiss', tabId: r.tabId }).then(render); li.append(b);
    } else {
      const p = document.createElement('button');
      p.textContent = r.state === 'paused' ? '다시' : '일시정지';
      p.disabled = !['recording', 'paused'].includes(r.state);
      p.onclick = () => send({ type: r.state === 'paused' ? 'resume' : 'pause', tabId: r.tabId }).then(render);
      const s = document.createElement('button'); s.textContent = '정지'; s.className = 'danger';
      s.disabled = r.state === 'stopping';
      s.onclick = () => send({ type: 'stop', tabId: r.tabId }).then(render);
      li.append(p, s);
    }
    $('#list').append(li);
  }
}

async function init() {
  settings = await getSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('#port').value = settings.port;
  $('#mic').checked = !!settings.mic;
  $('#serverAddr').textContent = settings.server;
  $('#dash').onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: settings.server }); };
  serverOk = !!(await health(settings.server));
  $('#serverOff').hidden = serverOk;
  await fillMics();
  await render();
  setInterval(render, 1000);
}

$('#mic').addEventListener('change', async (e) => { await chrome.storage.local.set({ mic: e.target.checked }); settings.mic = e.target.checked; fillMics(); });
$('#micSel').addEventListener('change', async (e) => { await chrome.storage.local.set({ micId: e.target.value }); settings.micId = e.target.value; });
$('#micPermBtn').addEventListener('click', (e) => { e.preventDefault(); openPermissionPage(); });
$('#port').addEventListener('change', async (e) => {
  const port = Number(e.target.value) || DEFAULT_PORT;
  await chrome.storage.local.set({ port });
  settings = await getSettings();
  $('#serverAddr').textContent = settings.server;
  serverOk = !!(await health(settings.server));
  $('#serverOff').hidden = serverOk;
  render();
});

$('#startBtn').addEventListener('click', async () => {
  showErr('');
  if ($('#mic').checked && (await micPermission()) !== 'granted') {
    // offscreen 문서는 권한 대화상자를 띄우지 못한다 → 확장 페이지에서 한 번 허락받는다
    showErr('마이크 허용 페이지를 열었습니다. 허용한 뒤 이 탭에서 다시 눌러 주세요.');
    openPermissionPage();
    return;
  }
  $('#startBtn').disabled = true;
  const r = await send({ type: 'start', tabId: tab.id, title: tab.title, url: tab.url, dpr: window.devicePixelRatio });
  if (!r?.ok) showErr(r?.error || '녹화를 시작하지 못했습니다.');
  render();
});

$('#pauseBtn').addEventListener('click', async () => {
  const { recs = {} } = await send({ type: 'list' });
  const mine = recs[tab.id];
  if (!mine) return;
  await send({ type: mine.state === 'paused' ? 'resume' : 'pause', tabId: tab.id });
  render();
});
$('#stopBtn').addEventListener('click', async () => { await send({ type: 'stop', tabId: tab.id }); render(); });

init();
