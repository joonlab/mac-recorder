// MacRecorder 대시보드
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: {} };
  if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const r = await fetch(`/api/${path}`, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
let toastT;
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
}
const pad = (n) => String(n).padStart(2, '0');
function hms(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
const bytes = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)}GB` : n > 1e6 ? `${(n / 1e6).toFixed(0)}MB` : `${Math.round(n / 1e3)}KB`);
function when(iso) {
  const d = new Date(iso);
  return d.toLocaleString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
function md(text) {
  // 요약용 작은 마크다운 렌더러(제목·목록·체크박스·굵게·코드)
  const lines = esc(text).split('\n');
  let out = '', inList = false;
  const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/_(.+?)_$/g, '<i>$1</i>');
  for (const l of lines) {
    const li = l.match(/^\s*[-*]\s+(\[( |x)\]\s+)?(.*)$/);
    if (li) {
      if (!inList) { out += '<ul>'; inList = true; }
      out += `<li>${li[1] ? `<input type="checkbox" disabled ${li[2] === 'x' ? 'checked' : ''}> ` : ''}${inline(li[3])}</li>`;
      continue;
    }
    if (inList) { out += '</ul>'; inList = false; }
    const h = l.match(/^(#{1,3})\s+(.*)$/);
    if (h) out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    else if (/^---+$/.test(l.trim())) out += '<hr>';
    else if (l.trim()) out += `<p>${inline(l)}</p>`;
  }
  if (inList) out += '</ul>';
  return out;
}

let state = { status: null, config: null, devices: null, sessions: [], open: null };

// ── 탭 ─────────────────────────────────────────────────────────
function showTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('on', t.id === `tab-${name}`));
  if (name === 'dict') loadDict();
  if (name === 'settings') loadSettings();
  history.replaceState(null, '', name === 'rec' ? '/' : `#${name}`);
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ── 상태 ────────────────────────────────────────────────────────
async function refreshStatus() {
  try {
    const s = await api('status');
    if (state.status && s.displaysRev !== state.status.displaysRev) loadDevices();   // 모니터를 꽂거나 뺐다
    state.status = s;
    renderControl();
    const pill = $('#pill');
    const nLive = (s.live || []).length;
    if (s.active) { pill.className = s.active.paused ? 'pill' : 'pill rec'; pill.textContent = `${s.active.paused ? '⏸ 일시정지' : '● 녹화 중'} ${hms(s.active.elapsedSec)}${nLive ? ` · 창·탭 ${nLive}` : ''}`; }
    else if (nLive) { pill.className = 'pill rec'; pill.textContent = `● 창·탭 ${nLive}개 녹화 중`; }
    else { pill.className = 'pill'; pill.textContent = '대기 중'; }
    renderLive();
    const b = $('#propBadge'); b.hidden = !s.proposals; b.textContent = s.proposals;
    renderBanners();
  } catch {
    const pill = $('#pill'); pill.className = 'pill err'; pill.textContent = '서버에 연결할 수 없음';
  }
}
let permCache = null;
function renderBanners() {
  const s = state.status; const out = [];
  if (permCache && (!permCache.screen || permCache.microphone !== 'authorized')) {
    const miss = [!permCache.screen && '화면 기록', permCache.microphone !== 'authorized' && '마이크'].filter(Boolean).join('·');
    out.push(`<div class="banner err"><span>⚠️ <b>${miss}</b> 권한이 아직 없습니다. 녹화하려면 허용이 필요합니다.</span><button data-act="perm">권한 설정</button></div>`);
  }
  const mb = s?.menubar;
  if (mb && mb.expected && mb.installed && mb.running === false) {
    out.push(`<div class="banner warn"><span>메뉴바 아이콘이 꺼져 있습니다. 단축키 ⌃⌥⌘R(녹화)·⌃⌥⌘P(일시정지)도 지금은 동작하지 않습니다.</span><button data-act="menubar">메뉴바 아이콘 다시 띄우기</button></div>`);
  }
  if (s && !s.whisper.ready) out.push(`<div class="banner warn"><span>전사 기능이 설치되지 않았습니다. 녹화는 됩니다. 전사가 필요하면 터미널에서 <code>./install.sh --with-transcribe</code></span></div>`);
  $('#banners').innerHTML = out.join('');
  $$('#banners [data-act="perm"]').forEach((b) => b.addEventListener('click', () => showTab('settings')));
  $$('#banners [data-act="menubar"]').forEach((b) => b.addEventListener('click', () => menubarAction('show', b)));
  renderMenubarState();
}
// ── 메뉴바 아이콘 ───────────────────────────────────────────────
async function menubarAction(action, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api('menubar', { body: { action } });
    toast(action === 'hide' ? '메뉴바 아이콘을 숨겼습니다. 단축키는 계속 동작합니다.' : r.how === 'launched' ? '메뉴바 앱을 다시 켰습니다. 화면 오른쪽 위를 확인하세요.' : '메뉴바 아이콘을 다시 보이게 했습니다.', 4500);
    setTimeout(refreshStatus, 1500);
  } catch (e) { toast(e.message, 6000); }
  finally { if (btn) btn.disabled = false; }
}
function renderMenubarState() {
  const el = $('#mbState'); if (!el) return;
  const mb = state.status?.menubar;
  if (!mb) { el.textContent = ''; return; }
  el.textContent = !mb.installed ? `메뉴바 앱이 설치되어 있지 않습니다(${mb.app}).`
    : mb.running === null ? '확인 중…'
    : !mb.running ? '⛔ 꺼져 있음 — 아이콘과 단축키가 모두 동작하지 않습니다.'
    : mb.iconHidden ? '아이콘 숨김 — 단축키는 동작합니다.' : '✅ 켜져 있음';
  $('#mbHide').disabled = !mb.running || mb.iconHidden;
  $('#mbShow').disabled = !mb.installed || (mb.running && !mb.iconHidden);
}
$('#mbShow').addEventListener('click', (e) => menubarAction('show', e.currentTarget));
$('#mbHide').addEventListener('click', (e) => menubarAction('hide', e.currentTarget));

// ── 녹화 제어 ───────────────────────────────────────────────────
function recOpts() {
  const r = state.status?.record || {};
  return r;
}
function renderControl() {
  const s = state.status; if (!s) return;
  const a = s.active;
  const btn = $('#recBtn');
  btn.classList.toggle('on', !!a);
  btn.setAttribute('aria-label', a ? '녹화 정지' : '녹화 시작');
  $('#recTitle').textContent = a ? `${a.paused ? '일시정지' : '녹화 중'} ${hms(a.elapsedSec)}${a.state === 'starting' ? ' (시작 중…)' : ''}` : '녹화 준비됨';
  const pb = $('#pauseBtn');
  pb.hidden = !a || a.state === 'starting';
  pb.textContent = a?.paused ? '● 다시 녹화' : '⏸ 일시정지';
  btn.classList.toggle('paused', !!a?.paused);
  const last = a?.events?.[a.events.length - 1];
  if (last) $('#recTitle').insertAdjacentHTML('beforeend', `<div class="muted" style="font-size:13px;font-weight:400">${esc(evText(last, a.startedAt))}</div>`);
  const r = recOpts();
  for (const cb of $$('#srcChips input')) {
    if (document.activeElement !== cb) cb.checked = !!(a ? a.sources?.[cb.dataset.src] : r[cb.dataset.src]);
    cb.disabled = !!a;
  }
  $('#selDisplay').disabled = !!a || !r.video; $('#selMic').disabled = !!a || !r.mic;
  const parts = [];
  if (r.video) parts.push('화면을 영상(mp4)으로');
  if (r.mic || r.system) parts.push(`${[r.mic && '마이크', r.system && '시스템 소리'].filter(Boolean).join('와 ')}를 함께`);
  const why = { sleep: '맥이 잠자기에 들어가 자동으로 일시정지했습니다. ', lock: '화면이 잠겨 자동으로 일시정지했습니다. ' }[a?.pauseReason] || '';
  $('#srcHint').textContent = a ? (a.paused ? `${why}일시정지 중에는 화면·소리를 전혀 녹화하지 않습니다. «다시 녹화»를 누르면 같은 파일에 이어집니다.` : '⌃⌥⌘P 로 일시정지, ⌃⌥⌘R 로 정지할 수 있습니다(메뉴바에서도).')
    : (r.video ? `${parts.join(' ')} 녹화합니다.` : `${[r.mic && '마이크', r.system && '시스템 소리'].filter(Boolean).join('와 ')}만 오디오(m4a)로 녹음합니다.`)
      + (r.system ? '' : ' 화상회의 상대 목소리도 남기려면 «시스템 소리»를 켜세요.');
  if (state.devices) renderMicHint();
}
async function loadDevices(fresh = false) {
  try {
    state.devices = await api(`devices${fresh ? '?fresh=1' : ''}`);
    const r = recOpts();
    const ds = state.devices.displays || [];
    $('#selDisplay').innerHTML = `<option value="all">${ds.length > 1 ? `전체 화면 (${ds.length}개)` : '주 화면'}</option>`
      + (ds.length > 1 ? ds.map((d) => `<option value="${d.id}">${esc(d.name)}${d.main ? ' (주)' : ''}</option>`).join('') : '');
    const want = String(r.display || 'all');
    if (want !== 'all' && !ds.some((d) => String(d.id) === want)) {
      // 고른 화면이 지금 연결돼 있지 않다 → 선택은 남겨 두고 표시만(녹화하면 남은 화면으로 녹화된다)
      $('#selDisplay').insertAdjacentHTML('beforeend', `<option value="${esc(want)}">선택했던 화면 (연결 안 됨)</option>`);
    }
    $('#selDisplay').value = want;
    const ms = sortMics(state.devices.mics || []);
    const def = ms.find((m) => m.default);
    $('#selMic').innerHTML = `<option value="">시스템 기본 (${esc(def ? micLabel(def) : '-')})</option>`
      + ms.map((m) => `<option value="${esc(m.id)}">${esc(micLabel(m))}</option>`).join('');
    if (r.micId && !ms.some((m) => m.id === r.micId)) {
      // 고른 마이크가 지금 연결돼 있지 않다(블루투스 이어폰을 껐을 때 등) → 선택은 남겨 두고 표시만
      $('#selMic').insertAdjacentHTML('beforeend', `<option value="${esc(r.micId)}">선택했던 마이크 (연결 안 됨)</option>`);
    }
    $('#selMic').value = r.micId || '';
    renderMicHint();
  } catch (e) { $('#selDisplay').innerHTML = '<option value="all">주 화면</option>'; }
}
// 마이크 종류 표시: 블루투스 이어폰·노트북 내장·USB·가상 장치(Zoom·Teams·BlackHole)를 구분
const MIC_KIND = { builtin: '내장', bluetooth: '블루투스', usb: 'USB', virtual: '가상 장치', aggregate: '묶음 장치', display: '모니터', thunderbolt: 'Thunderbolt' };
const micLabel = (m) => `${m.name}${MIC_KIND[m.kind] ? ` · ${MIC_KIND[m.kind]}` : ''}`;
const sortMics = (ms) => [...ms].sort((a, b) => (a.kind === 'virtual') - (b.kind === 'virtual'));
function renderMicHint() {
  const r = recOpts(); const ms = state.devices?.mics || [];
  const cur = r.micId ? ms.find((m) => m.id === r.micId) : ms.find((m) => m.default);
  let t = '';
  if (r.micId && !cur) t = '고른 마이크가 지금 연결돼 있지 않습니다. 이대로 녹화하면 시스템 기본 마이크로 녹음하고 녹화 기록에 남깁니다.';
  else if (cur?.kind === 'bluetooth') t = '블루투스 이어폰 마이크를 쓰는 동안에는 이어폰으로 듣는 소리 음질이 통화 수준으로 낮아집니다(macOS 블루투스 특성). 소리를 좋게 들어야 하면 노트북 마이크를 고르세요.';
  else if (cur?.kind === 'virtual') t = '가상 장치는 Zoom·Teams 같은 앱이 만든 장치라 내 목소리가 들어가지 않을 수 있습니다.';
  $('#micHint').textContent = r.mic ? t : '';
}
async function saveRecord(patch) {
  await api('config', { method: 'PUT', body: { record: patch } });
  await refreshStatus();
}
$$('#srcChips input').forEach((cb) => cb.addEventListener('change', () => saveRecord({ [cb.dataset.src]: cb.checked })));
$('#selDisplay').addEventListener('change', (e) => saveRecord({ display: e.target.value }));
$('#selMic').addEventListener('change', (e) => saveRecord({ micId: e.target.value }));
// 목록을 열 때마다 마이크를 새로 읽는다(블루투스 이어폰을 방금 연결했을 수 있다)
$('#selMic').addEventListener('mousedown', () => { if (Date.now() - (state.micAt || 0) > 3000) { state.micAt = Date.now(); loadDevices(true); } });
$('#pauseBtn').addEventListener('click', async () => {
  try { const r = await api('pause', { body: {} }); toast(r.paused ? '일시정지했습니다. 이 동안은 녹화되지 않습니다.' : '다시 녹화합니다.'); }
  catch (e) { toast(e.message, 5000); }
  refreshStatus();
});
$('#recBtn').addEventListener('click', async () => {
  const btn = $('#recBtn'); btn.disabled = true;
  try {
    if (state.status?.active) { await api('stop', { body: {} }); toast('녹화를 멈췄습니다. 파일을 정리하는 중입니다.'); }
    else { await api('start', { body: {} }); toast('녹화를 시작했습니다.'); }
  } catch (e) { toast(e.message, 6000); }
  btn.disabled = false;
  await refreshStatus(); loadSessions();
});

// ── 창·탭 따로 녹화 ─────────────────────────────────────────────
function renderLive() {
  const live = state.status?.live || [];
  const el = $('#liveList');
  if (!live.length) { el.innerHTML = ''; return; }
  el.innerHTML = live.map((e) => {
    const name = e.kind === 'window' ? `🪟 ${esc(e.window?.app || '')} — ${esc(e.title || '')}` : `🌐 ${esc(e.title || '브라우저 탭')}`;
    const why = { sleep: ' (잠자기로 자동 일시정지)', lock: ' (화면 잠금으로 자동 일시정지)' }[e.pauseReason] || '';
    return `<div class="live ${e.paused ? 'paused' : ''}" data-id="${e.id}">
      <span class="dot">●</span><span class="t" title="${esc(e.title || '')}">${name}</span>
      <span class="muted">${e.paused ? `일시정지${why}` : hms(e.recordedSec)}${e.kind === 'tab' && e.cmd ? ' · 확장에 전달 중' : ''}</span>
      <button class="ghost" data-a="pause">${e.paused ? '● 다시 녹화' : '⏸'}</button><button class="ghost" data-a="stop">■ 정지</button></div>`;
  }).join('');
  $$('#liveList .live button').forEach((b) => b.addEventListener('click', async () => {
    const id = b.closest('.live').dataset.id;
    try {
      const r = await api(`live/${id}/${b.dataset.a}`, { body: {} });
      toast(b.dataset.a === 'stop' ? '녹화를 멈췄습니다. 파일을 정리하는 중입니다.' : r.paused ? '일시정지했습니다.' : '다시 녹화합니다.');
    } catch (e) { toast(e.message, 5000); }
    refreshStatus(); loadSessions();
  }));
}
let wins = [];
async function loadWindows() {
  $('#winList').innerHTML = '<div class="muted" style="padding:10px">창 목록을 읽는 중…</div>';
  try { wins = (await api('windows')).windows; } catch (e) { $('#winList').innerHTML = `<div class="muted" style="padding:10px">⛔ ${esc(e.message)}</div>`; return; }
  renderWindows();
}
function renderWindows() {
  const q = $('#winSearch').value.trim().toLowerCase();
  const busy = new Set((state.status?.live || []).filter((e) => e.kind === 'window').map((e) => e.window?.id));
  const list = wins.filter((w) => !q || `${w.app} ${w.title}`.toLowerCase().includes(q));
  const apps = [...new Set(list.map((w) => w.app))].sort((a, b) => a.localeCompare(b, 'ko'));
  $('#winList').innerHTML = apps.map((app) => {
    const ws = list.filter((w) => w.app === app).sort((a, b) => b.onScreen - a.onScreen);
    return `<div class="app">${esc(app)}${ws[0].browser ? ' · 브라우저(맥 전체 소리)' : ''}</div>` + ws.map((w) => `
      <label><input type="checkbox" value="${w.id}" ${busy.has(w.id) ? 'disabled' : ''}>
        <span class="wt">${esc(w.title || '(제목 없음)')}</span>
        <small>${busy.has(w.id) ? '녹화 중' : `${w.width}×${w.height}${w.onScreen ? '' : ' · 숨김·다른 데스크탑'}`}</small></label>`).join('');
  }).join('') || '<div class="muted" style="padding:10px">녹화할 수 있는 창이 없습니다.</div>';
  $$('#winList input').forEach((cb) => cb.addEventListener('change', () => { $('#winStart').disabled = !$$('#winList input:checked').length; }));
  $('#winStart').disabled = true;
}
$('#pickWin').addEventListener('click', () => {
  const p = $('#winPicker'); p.hidden = !p.hidden;
  if (!p.hidden) { $('#winMic').checked = !!recOpts().mic; loadWindows(); }
});
$('#winClose').addEventListener('click', () => { $('#winPicker').hidden = true; });
$('#winReload').addEventListener('click', loadWindows);
$('#winSearch').addEventListener('input', renderWindows);
$('#winStart').addEventListener('click', async () => {
  const ids = $$('#winList input:checked').map((cb) => Number(cb.value));
  $('#winStart').disabled = true; $('#winMsg').textContent = '시작하는 중…';
  let ok = 0; const errs = [];
  for (const windowId of ids) {
    try { await api('windows/start', { body: { windowId, mic: $('#winMic').checked } }); ok++; }
    catch (e) { errs.push(e.message); }
  }
  $('#winMsg').textContent = '';
  toast(errs.length ? `${ok}개 시작 · 실패 ${errs.length}: ${errs[0]}` : `창 ${ok}개 녹화를 시작했습니다.`, errs.length ? 6000 : 3200);
  if (ok) $('#winPicker').hidden = true;
  refreshStatus(); loadSessions();
});

// ── 녹화 목록 ───────────────────────────────────────────────────
function jobTag(s) {
  const j = s.job;
  if (s.status === 'recording') {
    const a = state.status?.active?.id === s.id ? state.status.active : (state.status?.live || []).find((x) => x.id === s.id);
    return a?.paused ? '<span class="tag">⏸ 일시정지</span>' : '<span class="tag err">● 녹화 중</span>';
  }
  if (s.status === 'failed') return '<span class="tag err">실패</span>';
  if (j && (j.status === 'running' || j.status === 'queued')) return `<span class="tag run">${esc(j.step || '처리 중')}${j.progress != null ? ` ${j.progress}%` : ''}</span>`;
  const t = [];
  const moves = (s.captureEvents || []).filter((e) => /lost|added/.test(e.type)).length;
  const pauses = (s.captureEvents || []).filter((e) => e.type === 'paused').length;
  if (pauses) t.push(`<span class="tag" title="녹화 중 일시정지한 횟수(멈춘 동안은 녹화되지 않음)">일시정지 ${pauses}</span>`);
  if (moves) t.push(`<span class="tag" title="녹화 중 모니터 연결이 바뀌었습니다">화면 변화 ${moves}</span>`);
  if (s.hasTranscript) t.push('<span class="tag ok">전사</span>');
  if (s.hasSummary) t.push('<span class="tag ok">요약</span>');
  if (j?.status === 'error') t.push('<span class="tag err">오류</span>');
  return t.join('');
}
// 녹화 중 화면 변화 기록(모니터 분리·연결) → 사람이 읽는 문장
// «으로/로»: 받침이 있으면(ㄹ 받침 제외) «으로»
function ro(n) {
  const c = n.charCodeAt(n.length - 1);
  if (c >= 0xac00 && c <= 0xd7a3) { const j = (c - 0xac00) % 28; return `${n}${j && j !== 8 ? '으로' : '로'}`; }
  return `${n}로`;
}
const EV = {
  'primary-lost': (n) => `${n} 연결이 끊김`,
  'primary-moved': (n) => `${ro(n)} 옮겨 계속 녹화`,
  'primary-returned': (n) => `${ro(n)} 돌아옴`,
  'primary-resumed': (n) => `${n}에서 녹화 재개`,
  'display-lost': (n) => `${n} 분리 — 이 화면만 일시정지, 녹화는 계속`,
  'display-resumed': (n) => `${n} 다시 연결 — 이어서 녹화`,
  'display-added': (n) => `${n} 새로 연결 — 녹화에 추가`,
  paused: (n, e) => ({ sleep: '잠자기로 자동 일시정지', lock: '화면 잠금으로 자동 일시정지' }[e?.detail] || '일시정지'),
  resumed: (n, e) => `다시 녹화${e?.detail ? ` (${e.detail.replace('초 멈춤', '')}초 동안 멈춤)` : ''}`,
  'window-lost': () => '창 녹화가 잠시 끊김 — 다시 연결',
  'window-resumed': () => '창 녹화 다시 연결',
  'window-closed': () => '녹화하던 창이 닫혀 녹화를 마침',
  'mic-fallback': () => '고른 마이크가 없어 시스템 기본 마이크로 녹음',
  'tab-lost': () => '브라우저와 연결이 끊겨 녹화를 마침',
  ended: () => '탭 녹화가 끊겨(탭을 닫거나 페이지 이동) 녹화를 마침',
};
function evText(e, startIso) {
  const t = startIso ? hms((new Date(e.at) - new Date(startIso)) / 1000) : new Date(e.at).toLocaleTimeString('ko-KR');
  // 일시정지 기록은 «파일 안의 시각»(t)으로 보여 준다(멈춘 시간은 파일에 없으므로)
  const tt = typeof e.t === 'number' ? hms(e.t) : t;
  return `${/paused|resumed/.test(e.type) ? tt : t} · ${(EV[e.type] || ((n) => `${e.type} ${n}`))(e.name || '화면', e)}`;
}
function icon(s) { return s.kind === 'window' ? '🪟' : s.kind === 'tab' ? '🌐' : s.sources?.video ? '🖥' : '🎙'; }
function srcText(s) {
  const v = s.kind === 'window' ? `창(${s.window?.app || '?'})` : s.kind === 'tab' ? '브라우저 탭' : '화면';
  const sys = s.kind === 'window' ? (s.window?.audio === 'app' ? '앱 소리' : '맥 전체 소리') : s.kind === 'tab' ? '탭 소리' : '시스템 소리';
  return [s.sources?.video && v, s.sources?.mic && '마이크', s.sources?.system && sys].filter(Boolean).join('·');
}
async function loadSessions() {
  try { state.sessions = (await api('sessions')).sessions; } catch { return; }
  if (!renaming) renderSessions();
  if (state.open) { const s = state.sessions.find((x) => x.id === state.open); if (s) updateDrawerLive(s); }
}
function renderSessions() {
  const q = $('#search').value.trim().toLowerCase();
  const list = state.sessions.filter((s) => !q || `${s.title} ${s.id} ${s.folder || ''} ${s.window?.app || ''} ${when(s.createdAt)}`.toLowerCase().includes(q));
  if (!list.length) {
    $('#sessions').innerHTML = `<div class="empty">${q ? '검색 결과가 없습니다.' : '아직 녹화가 없습니다.<br>위의 빨간 버튼이나 메뉴바 아이콘으로 시작해 보세요.'}</div>`;
    return;
  }
  const mode = state.config?.naming?.listLabel || 'title';
  $('#sessions').innerHTML = list.map((s) => {
    const folder = s.folder || s.id;
    const big = mode === 'folder' ? folder : (s.title || when(s.createdAt));
    const showWhen = mode === 'folder' || s.title;
    return `
    <div class="sess" data-id="${s.id}">
      <div class="ic">${icon(s)}</div>
      <div style="min-width:0"><div class="t"><span class="nm" title="${esc(big)}">${esc(big)}</span><button class="edit" data-edit aria-label="이름 바꾸기" title="이름 바꾸기">✏️</button>${s.renamePending ? '<span class="pend" title="녹화·처리가 끝나면 폴더 이름이 바뀝니다">이름 바꿈 대기</span>' : ''}</div>
        ${mode === 'both' ? `<div class="fn mono" title="Finder 폴더 이름">${esc(folder)}</div>` : ''}
        <div class="m">${showWhen ? `${when(s.createdAt)} · ` : ''}${hms(s.durationSec)} · ${srcText(s)} · ${bytes(s.bytes)}</div></div>
      <div class="tagrow">${jobTag(s)}</div>
    </div>`;
  }).join('');
  $$('.sess').forEach((el) => {
    let clickT = null;
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-edit], input.rename')) return;
      // 이름 위 클릭은 두 번 누르기(이름 바꾸기)일 수 있어 잠깐 기다렸다 연다
      if (e.target.closest('.nm')) { clearTimeout(clickT); if (e.detail === 1) clickT = setTimeout(() => openSession(el.dataset.id), 260); return; }
      openSession(el.dataset.id);
    });
    el.querySelector('[data-edit]').addEventListener('click', (e) => { e.stopPropagation(); startRename(el); });
    el.querySelector('.nm').addEventListener('dblclick', (e) => { e.stopPropagation(); clearTimeout(clickT); startRename(el); });
  });
}
// ── 목록에서 바로 이름 바꾸기 ─────────────────────────────────────
// 제목을 고치면 서버가 폴더 이름(설정을 켰으면 폴더 안 파일 이름도)을 규칙대로 바꾼다. 녹화·처리 중이면 끝난 뒤.
let renaming = null;
function startRename(el) {
  const s = state.sessions.find((x) => x.id === el.dataset.id); if (!s) return;
  renaming = s.id;
  const t = el.querySelector('.t');
  t.innerHTML = `<input class="rename" value="${esc(s.title || '')}" placeholder="${esc(when(s.createdAt))}" aria-label="새 이름">`;
  const inp = t.querySelector('input');
  inp.focus(); inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const v = inp.value.trim();
    renaming = null;
    if (!save || v === (s.title || '')) return renderSessions();
    inp.disabled = true;
    try {
      const r = await api(`sessions/${s.id}`, { method: 'PATCH', body: { title: v } });
      const n = r.naming || {};
      toast(n.error ? n.error : n.pending ? '제목을 바꿨습니다. 녹화·처리가 끝나면 폴더 이름도 바뀝니다.' : n.renamed ? `이름을 바꿨습니다 → ${n.name}` : '제목을 바꿨습니다.', n.error ? 7000 : 4000);
    } catch (e) { toast(e.message, 6000); }
    await loadSessions();
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('click', (e) => e.stopPropagation());
}
$('#search').addEventListener('input', () => { if (!renaming) renderSessions(); });
$('#openFolder').addEventListener('click', () => api('open', { body: { what: 'recordings' } }));

// ── 녹화 상세 ───────────────────────────────────────────────────
let detail = null, editing = false;
async function openSession(id) {
  state.open = id;
  history.replaceState(null, '', `#s=${id}`);
  detail = await api(`sessions/${id}`);
  editing = false;
  $('#drawer').hidden = false;
  renderDrawer();
}
function closeDrawer() {
  $('#drawer').hidden = true; state.open = null; detail = null;
  const v = $('#dPlayer video, #dPlayer audio'); if (v) v.pause();
  history.replaceState(null, '', '/');
}
$$('#drawer [data-close]').forEach((b) => b.addEventListener('click', closeDrawer));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#drawer').hidden && !editing) closeDrawer(); });

function fileUrl(id, name, dl) { return `/api/sessions/${id}/file/${encodeURIComponent(name)}${dl ? '?download=1' : ''}`; }

function renderDrawer() {
  const { session: s } = detail;
  $('#dTitle').value = s.title || '';
  $('#dTitle').placeholder = when(s.createdAt);
  $('#dMeta').textContent = `${when(s.createdAt)} · ${hms(s.durationSec)} · ${srcText(s)} · ${bytes(s.bytes)} · 폴더 ${s.folder || s.id}`;
  const p = $('#dPlayer');
  if (s.play) {
    p.innerHTML = s.playKind === 'audio'
      ? `<audio controls preload="metadata" src="${fileUrl(s.id, s.play)}"></audio>`
      : `<video controls preload="metadata" src="${fileUrl(s.id, s.play)}"></video>`;
    const m = $('video, audio', p);
    m.addEventListener('timeupdate', () => highlightSeg(m.currentTime));
  } else p.innerHTML = '<div class="muted">재생할 파일이 아직 없습니다.</div>';
  renderActions(); renderJob(); renderTranscript(); renderSummary(); renderFiles();
}
function updateDrawerLive(s) {
  // 처리 진행 상황만 갱신. 작업이 끝났으면 전사·요약을 다시 읽는다
  const prev = detail?.session;
  if (!prev) return;
  const wasBusy = prev.job && ['running', 'queued'].includes(prev.job.status);
  const isBusy = s.job && ['running', 'queued'].includes(s.job.status);
  detail.session = { ...prev, ...s };
  renderJob(); renderActions();
  if ((wasBusy && !isBusy) || (prev.status !== 'ready' && s.status === 'ready')) openSession(s.id);
}
function renderActions() {
  const s = detail.session; const st = state.status;
  const busy = s.job && ['running', 'queued'].includes(s.job.status);
  const hasAudio = s.sources?.mic || s.sources?.system;
  const ai = st?.ai || {};
  const btns = [];
  btns.push(`<button class="ghost" data-a="reveal">폴더 열기</button>`);
  if (hasAudio && s.status === 'ready') {
    btns.push(`<button ${busy || !st?.whisper.ready ? 'disabled' : ''} data-a="transcribe">${s.hasTranscript ? '다시 전사' : '전사'}</button>`);
    if (s.hasTranscript) {
      if (ai.runnable) {
        btns.push(`<button ${busy ? 'disabled' : ''} data-a="correct">AI 교정</button>`);
        btns.push(`<button ${busy ? 'disabled' : ''} data-a="summarize">${s.hasSummary ? '다시 요약' : 'AI 요약'}</button>`);
      }
      btns.push(`<button class="ghost" data-a="cc">Claude Code로 정리 (지시문 복사)</button>`);
    }
  }
  btns.push(`<button class="danger" data-a="delete">휴지통으로</button>`);
  $('#dActions').innerHTML = btns.join('');
  $$('#dActions button').forEach((b) => b.addEventListener('click', () => act(b.dataset.a)));
}
async function act(a) {
  const id = detail.session.id;
  try {
    if (a === 'reveal') return api(`sessions/${id}/reveal`, { body: {} });
    if (a === 'cc') {
      await navigator.clipboard.writeText(detail.claudeCodePrompt);
      return toast('지시문을 복사했습니다. Claude Code 세션에 붙여 넣으세요.', 5000);
    }
    if (a === 'delete') {
      if (!confirm('이 녹화 폴더를 휴지통으로 옮길까요? (휴지통에서 되돌릴 수 있습니다)')) return;
      await api(`sessions/${id}`, { method: 'DELETE' });
      closeDrawer(); loadSessions(); return toast('휴지통으로 옮겼습니다.');
    }
    await api(`sessions/${id}/${a}`, { body: {} });
    toast('백그라운드에서 처리합니다. 창을 닫아도 계속됩니다.');
    loadSessions();
  } catch (e) { toast(e.message, 6000); }
}
function renderJob() {
  const s = detail.session; const j = s.job;
  let h = '';
  if (s.status === 'recording') h = '<div class="job">● 녹화 중입니다.</div>';
  else if (j && ['running', 'queued'].includes(j.status)) {
    h = `<div class="job">${esc(j.step || '처리 중')}${j.progress != null ? ` · ${j.progress}%` : ''}<div class="bar"><i style="width:${j.progress ?? 15}%"></i></div></div>`;
  } else if (j?.status === 'error') h = `<div class="job" style="color:var(--accent)">처리 오류: ${esc(j.error)}</div>`;
  else if (s.status === 'failed') h = `<div class="job" style="color:var(--accent)">녹화 실패: ${esc(s.error || '')}</div>`;
  const ev = s.captureEvents || [];
  if (ev.length) h += `<details class="job"><summary>녹화 중 기록 ${ev.length}건 (화면 변화·일시정지)</summary>${ev.map((e) => `<div class="muted">${esc(evText(e, s.createdAt))}</div>`).join('')}</details>`;
  $('#dJob').innerHTML = h;
}
function renderTranscript() {
  const t = detail.transcript; const el = $('#sub-tx');
  if (!t?.segments?.length) {
    el.innerHTML = `<div class="muted">${detail.session.sources?.mic || detail.session.sources?.system ? '아직 전사가 없습니다. 위의 «전사» 버튼을 누르세요.' : '소리 없이 화면만 녹화했습니다.'}</div>`;
    return;
  }
  const sp = (x) => (x ? `<span class="sp ${x === '나' ? 'me' : 'you'}">${esc(x)}</span>` : '');
  el.innerHTML = `
    <div class="row wrap" style="justify-content:space-between;margin-bottom:8px">
      <span class="muted">${esc(t.engine || '')}${t.corrected?.length ? ` + ${esc(t.corrected.join(', '))}` : ''}</span>
      <span class="row">${editing
        ? '<button class="ghost" id="txCancel">취소</button><button id="txSave">저장하고 교정 제안 만들기</button>'
        : '<button class="ghost" id="txEdit">직접 고치기</button>'}
        <a class="muted" href="${fileUrl(detail.session.id, 'transcript.md', true)}">.md</a>
        <a class="muted" href="${fileUrl(detail.session.id, 'transcript.srt', true)}">.srt</a></span>
    </div>
    ${editing ? '<p class="muted">잘못 들은 단어를 고치고 저장하면, 바뀐 부분이 «교정 제안»으로 올라갑니다. 승인하면 다음 녹화부터 자동으로 고쳐집니다.</p>' : ''}
    <div id="segs">${t.segments.map((g, i) => `<div class="seg" data-i="${i}" data-t="${g.start}"><span class="ts">${hms(g.start)}</span><div>${sp(g.speaker)}<span class="tx" ${editing ? 'contenteditable="true"' : ''}>${esc(g.text)}</span></div></div>`).join('')}</div>`;
  $$('#segs .ts').forEach((x) => x.addEventListener('click', () => {
    const m = $('#dPlayer video, #dPlayer audio'); if (m) { m.currentTime = Number(x.parentElement.dataset.t); m.play(); }
  }));
  $('#txEdit')?.addEventListener('click', () => { editing = true; renderTranscript(); });
  $('#txCancel')?.addEventListener('click', () => { editing = false; renderTranscript(); });
  $('#txSave')?.addEventListener('click', saveTranscript);
}
async function saveTranscript() {
  const edits = [];
  $$('#segs .seg').forEach((el) => {
    const i = Number(el.dataset.i); const txt = $('.tx', el).innerText.trim();
    if (txt !== detail.transcript.segments[i].text) edits.push({ i, text: txt });
  });
  if (!edits.length) { editing = false; return renderTranscript(); }
  try {
    const r = await api(`sessions/${detail.session.id}/transcript`, { method: 'PUT', body: { edits } });
    toast(r.proposals ? `저장했습니다. 교정 제안 ${r.proposals}개가 «교정 사전»에 올라갔습니다.` : '저장했습니다.', 5000);
    editing = false; await openSession(detail.session.id); refreshStatus();
  } catch (e) { toast(e.message); }
}
let lastNow = -1;
function highlightSeg(t) {
  const segs = detail?.transcript?.segments; if (!segs) return;
  let k = -1; for (let i = 0; i < segs.length; i++) if (segs[i].start <= t) k = i; else break;
  if (k === lastNow) return; lastNow = k;
  $$('#segs .seg').forEach((el) => el.classList.toggle('now', Number(el.dataset.i) === k));
}
function renderSummary() {
  const el = $('#sub-sum');
  if (detail.summary) {
    el.innerHTML = `<div class="row" style="justify-content:flex-end"><button class="ghost" id="copySum">복사</button></div><div class="md">${md(detail.summary)}</div>`;
    $('#copySum').addEventListener('click', async () => { await navigator.clipboard.writeText(detail.summary); toast('요약을 복사했습니다.'); });
  } else {
    const ai = state.status?.ai;
    el.innerHTML = `<div class="muted">아직 요약이 없습니다. ${ai?.runnable ? '«AI 요약»을 누르세요.' : '«Claude Code로 정리» 버튼으로 지시문을 복사해 내 Claude Code 세션에 붙여 넣거나, 설정에서 OpenAI·Anthropic 키를 넣으세요.'}</div>`;
  }
}
function renderFiles() {
  const s = detail.session;
  const names = [s.media, s.play !== s.media && s.play, ...(s.extras || []), s.hasTranscript && 'transcript.md', s.hasTranscript && 'transcript.txt', s.hasTranscript && 'transcript.srt', s.hasSummary && 'summary.md'].filter(Boolean);
  const shown = (n) => s.fileNames?.[n] || n;   // 폴더 이름을 따라 바꾼 파일은 바뀐 이름으로 보인다
  $('#sub-files').innerHTML = `<div class="files">${[...new Set(names)].map((n) => `<div class="row" style="justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--line)"><span class="mono" style="overflow-wrap:anywhere;min-width:0">${esc(shown(n))}</span><span class="row"><a href="${fileUrl(s.id, n, true)}">내려받기</a><button class="ghost" data-f="${esc(n)}">Finder</button></span></div>`).join('')}</div>
    <p class="muted">폴더: <span class="mono">${esc(s.dir)}</span></p>`;
  $$('#sub-files [data-f]').forEach((b) => b.addEventListener('click', () => api(`sessions/${s.id}/reveal`, { body: { file: b.dataset.f } })));
}
$$('.subtabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.subtabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('.sub').forEach((x) => x.classList.toggle('on', x.id === `sub-${b.dataset.sub}`));
}));
$('#dTitle').addEventListener('change', async (e) => {
  const r = await api(`sessions/${detail.session.id}`, { method: 'PATCH', body: { title: e.target.value } }).catch((err) => ({ naming: { error: err.message } }));
  toast(r.naming?.error || (r.naming?.pending ? '제목을 바꿨습니다. 녹화·처리가 끝나면 폴더 이름도 바뀝니다.' : r.naming?.renamed ? `이름을 바꿨습니다 → ${r.naming.name}` : '제목을 바꿨습니다.'), 4500);
  if (r.session) { detail.session = r.session; renderDrawer(); }
  loadSessions();
});

// ── 교정 사전 ───────────────────────────────────────────────────
let gloss = null;
async function loadDict() {
  const [g, p, c] = await Promise.all([api('glossary'), api('proposals'), api('config')]);
  gloss = g; state.config = c;
  $('#context').value = c.context || '';
  renderGlossary();
  const list = p.proposals.sort((a, b) => b.count - a.count);
  $('#propCount').textContent = list.length ? `${list.length}개` : '';
  $('#proposals').innerHTML = list.length ? list.map((x, i) => `
    <div class="prop" data-i="${i}">
      <div><span class="from">${esc(x.from)}</span><small>${x.count}회 · ${esc(x.sources.map((s) => ({ ai: 'AI 교정', edit: '직접 수정', 'claude-code': 'Claude Code', manual: '수동' }[s] || s)).join(', '))}</small></div>
      <span>→</span><input value="${esc(x.to)}">
      <span class="row"><button data-ok>승인</button><button class="ghost" data-no>거절</button></span>
    </div>`).join('') : '<div class="muted">새 제안이 없습니다. 전사를 직접 고치거나 AI 교정을 돌리면 여기에 쌓입니다.</div>';
  $$('#proposals .prop').forEach((el) => {
    const x = list[Number(el.dataset.i)];
    $('[data-ok]', el).addEventListener('click', () => resolve(x, true, $('input', el).value));
    $('[data-no]', el).addEventListener('click', () => resolve(x, false));
  });
}
async function resolve(x, accept, editedTo) {
  await api('proposals/resolve', { body: { from: x.from, to: x.to, accept, editedTo } });
  toast(accept ? `규칙 추가: ${x.from} → ${editedTo}` : '거절했습니다. 같은 제안은 다시 올라오지 않습니다.');
  loadDict(); refreshStatus();
}
function renderGlossary() {
  $('#terms').innerHTML = gloss.terms.map((t, i) => `<span class="t">${esc(t)}<button data-i="${i}" aria-label="삭제">×</button></span>`).join('') || '<span class="muted">없음</span>';
  $$('#terms button').forEach((b) => b.addEventListener('click', () => { gloss.terms.splice(Number(b.dataset.i), 1); saveGloss(); }));
  $('#rules').innerHTML = gloss.replace.map((r, i) => `<tr><td>${esc(r.from)}</td><td>→</td><td>${esc(r.to)}</td><td style="text-align:right"><button class="icon" data-i="${i}" aria-label="삭제">×</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">없음</td></tr>';
  $$('#rules button').forEach((b) => b.addEventListener('click', () => { gloss.replace.splice(Number(b.dataset.i), 1); saveGloss(); }));
  $('#ignores').innerHTML = gloss.ignore.map((t, i) => `<span class="t">${esc(t)}<button data-i="${i}" aria-label="삭제">×</button></span>`).join('');
  $$('#ignores button').forEach((b) => b.addEventListener('click', () => { gloss.ignore.splice(Number(b.dataset.i), 1); saveGloss(); }));
}
async function saveGloss() { gloss = await api('glossary', { method: 'PUT', body: gloss }); renderGlossary(); }
$('#termForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#termInput').value.trim(); if (v) { gloss.terms.push(v); $('#termInput').value = ''; saveGloss(); } });
$('#ignoreForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#ignoreInput').value.trim(); if (v) { gloss.ignore.push(v); $('#ignoreInput').value = ''; saveGloss(); } });
$('#ruleForm').addEventListener('submit', (e) => {
  e.preventDefault(); const f = $('#ruleFrom').value.trim(), t = $('#ruleTo').value.trim();
  if (f && t) { gloss.replace.push({ from: f, to: t }); $('#ruleFrom').value = ''; $('#ruleTo').value = ''; saveGloss(); }
});
$('#saveContext').addEventListener('click', async () => { await api('config', { method: 'PUT', body: { context: $('#context').value } }); toast('맥락을 저장했습니다.'); });

// ── 설정 ────────────────────────────────────────────────────────
async function loadPerm() {
  try { permCache = await api('permissions'); } catch (e) { $('#perm').innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }
  const p = permCache;
  const row = (name, ok, pane, hint) => `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)">
    <span>${ok ? '✅' : '⛔'} ${name} <span class="muted">${hint}</span></span>${ok ? '' : `<button class="ghost" data-pane="${pane}">시스템 설정 열기</button>`}</div>`;
  $('#perm').innerHTML = row('화면 및 시스템 오디오 녹음', p.screen, 'screen', '— 화면·시스템 소리')
    + row('마이크', p.microphone === 'authorized', 'microphone', p.microphone === 'notDetermined' ? '— 아직 묻지 않음' : '— 내 목소리')
    + `<p class="muted">허용 대상 앱 이름은 <b>MacRecorder Capture</b> 입니다. ${!p.screen || p.microphone !== 'authorized' ? '<button id="permReq">권한 요청 창 띄우기</button>' : ''}</p>`;
  $$('#perm [data-pane]').forEach((b) => b.addEventListener('click', () => api('permissions/open-settings', { body: { pane: b.dataset.pane } })));
  $('#permReq')?.addEventListener('click', async () => {
    toast('권한 요청 창을 띄웠습니다. 허용한 뒤 «다시 확인»을 누르세요.', 6000);
    try { await api('permissions/request', { body: {} }); } catch {}
    loadPerm();
  });
  renderBanners();
}
$('#permRefresh').addEventListener('click', loadPerm);

async function loadSettings() {
  loadPerm();
  const c = await api('config'); state.config = c;
  $('#cfgWidth').value = String(c.record.width); $('#cfgFps').value = String(c.record.fps);
  $('#cfgAutoTx').checked = c.transcribe.auto; $('#cfgSplit').checked = c.transcribe.splitSpeakers; $('#cfgLang').value = c.transcribe.language;
  const w = state.status?.whisper;
  $('#whisperState').innerHTML = w?.ready ? `✅ whisper 준비됨 <span class="mono">${esc(w.model.split('/').pop())}</span>${w.vad ? ' · 무음 구간 거르기(VAD) 켜짐' : ''}` : '⛔ whisper 가 설치되지 않았습니다. 터미널에서 <code>./install.sh --with-transcribe</code>';
  $$('#providers input').forEach((r) => { r.checked = r.value === c.ai.provider; });
  $('#openaiModel').value = c.ai.openaiModel; $('#anthropicModel').value = c.ai.anthropicModel; $('#anthropicEffort').value = c.ai.anthropicEffort;
  $('#openaiKey').value = ''; $('#anthropicKey').value = '';
  $('#openaiKey').placeholder = c.secrets.openaiKey ? `저장됨 ${c.secrets.openaiKey}${c.secrets.openaiFromEnv ? ' (환경변수)' : ''}` : 'sk-...';
  $('#anthropicKey').placeholder = c.secrets.anthropicKey ? `저장됨 ${c.secrets.anthropicKey}${c.secrets.anthropicFromEnv ? ' (환경변수)' : ''}` : 'sk-ant-...';
  $('#cliState').innerHTML = c.claudeCli ? `✅ Claude Code 찾음: <span class="mono">${esc(c.claudeCli)}</span>` : '⛔ <code>claude</code> 명령을 찾지 못했습니다. Claude Code 를 설치하거나 다른 방식을 고르세요.';
  $('#cfgLlmCorr').checked = c.ai.llmCorrection; $('#cfgAutoSum').checked = c.ai.autoSummarize;
  showProv();
  const pr = await api('prompts/summary'); $('#promptText').value = pr.text;
  $('#paths').innerHTML = `녹화 폴더: <span class="mono">${esc(c.recordingsDir)}</span> <button class="ghost" id="openRec">열기</button><br>설정·사전: <span class="mono">~/.mac-recorder</span> <button class="ghost" id="openCfg">열기</button>`;
  $('#openRec').addEventListener('click', () => api('open', { body: { what: 'recordings' } }));
  $('#openCfg').addEventListener('click', () => api('open', { body: { what: 'settings-folder' } }));
  $('#tsCmd').textContent = `tailscale serve --bg --https=${c.port + 1000} http://127.0.0.1:${c.port}`;
  $('#recDir').value = c.recordingsDir; $('#recDirWarn').textContent = '';
  $('#namingPattern').value = c.naming?.pattern || '{date}_{time}_{title}';
  $('#namingFiles').checked = !!c.naming?.files;
  $$('#listLabel input').forEach((r) => { r.checked = r.value === (c.naming?.listLabel || 'title'); });
  previewNaming();
  renderMenubarState();
}
$$('#listLabel input').forEach((r) => r.addEventListener('change', async () => {
  state.config = await api('config', { method: 'PUT', body: { naming: { listLabel: r.value } } });
  renderSessions();
  toast('목록 이름 표시를 바꿨습니다.');
}));
$('#namingFiles').addEventListener('change', async (e) => {
  const on = e.target.checked;
  state.config = await api('config', { method: 'PUT', body: { naming: { files: on } } });
  const n = state.sessions.length;
  if (n && confirm(on ? `기존 녹화 ${n}개의 폴더 안 파일 이름도 지금 폴더 이름에 맞출까요?\n\n[취소] 를 누르면 앞으로 끝나는 녹화부터 적용합니다.` : `이름을 바꿔 둔 기존 녹화 파일을 원래 이름(recording.mp4·transcript.md …)으로 되돌릴까요?`)) {
    const r = await api('naming/apply', { body: {} });
    toast(`적용했습니다${r.pending ? ` · ${r.pending}개는 처리가 끝난 뒤` : ''}${r.failed ? ` · 실패 ${r.failed}개(원래 이름 유지)` : ''}.`, 5000);
  } else toast(on ? '앞으로 끝나는 녹화부터 파일 이름이 폴더 이름을 따릅니다.' : '앞으로는 파일 이름을 바꾸지 않습니다.', 4500);
  loadSessions();
});
// ── 녹화 폴더 바꾸기 ────────────────────────────────────────────
async function checkRecDir() {
  const p = $('#recDir').value.trim(); if (!p) return;
  try { const r = await api(`recordings-dir/check?path=${encodeURIComponent(p)}`); $('#recDirWarn').innerHTML = r.warnings.map((w) => `⚠️ ${esc(w)}`).join('<br>'); } catch {}
}
$('#recDir').addEventListener('change', checkRecDir);
$('#recDirPick').addEventListener('click', async () => {
  toast('Finder 창에서 폴더를 고르세요(다른 창 뒤에 떠 있을 수 있습니다).', 5000);
  const r = await api('recordings-dir/pick', { body: {} });
  if (r.path) { $('#recDir').value = r.path; checkRecDir(); }
});
$('#recDirSave').addEventListener('click', async () => {
  const p = $('#recDir').value.trim();
  const cur = state.config?.recordingsDir;
  if (!p || p === cur) return toast('지금 폴더와 같습니다.');
  const n = state.sessions.length;
  const chk = await api(`recordings-dir/check?path=${encodeURIComponent(p)}`).catch(() => ({ warnings: [] }));
  if (chk.warnings.length && !confirm(`${chk.warnings.join('\n\n')}\n\n그래도 이 폴더로 바꿀까요?`)) return;
  const move = n > 0 && confirm(`지금 폴더의 녹화 ${n}개를 새 폴더로 옮길까요?\n\n[확인] 옮기기  ·  [취소] 옮기지 않기(옮기지 않으면 기존 녹화는 대시보드 목록에서 보이지 않고, 지금 폴더에 그대로 남습니다)`);
  try {
    const r = await api('recordings-dir', { body: { path: p, move } });
    toast(`녹화 폴더를 바꿨습니다${move ? ` · ${r.moved}개 옮김${r.failed?.length ? `, 실패 ${r.failed.length}` : ''}` : ''}.`, 5000);
    await loadSettings(); loadSessions(); refreshStatus();
  } catch (e) { toast(e.message, 6000); }
});
// ── 폴더 이름 규칙 ──────────────────────────────────────────────
let namingT;
async function previewNaming() {
  const pat = $('#namingPattern').value.trim() || '{date}_{time}_{title}';
  try { const r = await api(`naming/preview?pattern=${encodeURIComponent(pat)}`); $('#namingPreview').innerHTML = `예: <span class="mono">${esc(r.sample)}</span> · 제목이 없으면 <span class="mono">${esc(r.untitled)}</span>`; } catch {}
}
$('#namingPattern').addEventListener('input', () => { clearTimeout(namingT); namingT = setTimeout(previewNaming, 250); });
$('#namingSave').addEventListener('click', async () => {
  await api('config', { method: 'PUT', body: { naming: { pattern: $('#namingPattern').value.trim() || '{date}_{time}_{title}' } } });
  toast('저장했습니다. 다음 녹화부터 이 규칙을 씁니다.');
});
$('#namingApply').addEventListener('click', async () => {
  await api('config', { method: 'PUT', body: { naming: { pattern: $('#namingPattern').value.trim() || '{date}_{time}_{title}' } } });
  if (!confirm(`기존 녹화 ${state.sessions.length}개의 폴더 이름을 이 규칙으로 바꿀까요? (녹화·처리 중인 것은 끝난 뒤 바뀝니다)`)) return;
  const r = await api('naming/apply', { body: {} });
  toast(`${r.renamed}개 이름을 바꿨습니다${r.pending ? ` · ${r.pending}개는 처리가 끝난 뒤` : ''}${r.failed ? ` · 실패 ${r.failed}개(원래 이름 유지)` : ''}.`, 5000);
  loadSessions();
});
function showProv() {
  const v = $('#providers input:checked')?.value;
  $$('.prov-detail').forEach((d) => d.classList.toggle('on', d.dataset.for === v));
}
$$('#providers input').forEach((r) => r.addEventListener('change', showProv));
async function saveTx() {
  await api('config', { method: 'PUT', body: { record: { width: Number($('#cfgWidth').value), fps: Number($('#cfgFps').value) },
    transcribe: { auto: $('#cfgAutoTx').checked, splitSpeakers: $('#cfgSplit').checked, language: $('#cfgLang').value } } });
  toast('저장했습니다.');
}
['#cfgWidth', '#cfgFps', '#cfgAutoTx', '#cfgSplit', '#cfgLang'].forEach((s) => $(s).addEventListener('change', saveTx));
$('#saveAi').addEventListener('click', async () => {
  const provider = $('#providers input:checked')?.value || 'none';
  const secrets = {};
  if ($('#openaiKey').value.trim()) secrets.openaiKey = $('#openaiKey').value.trim();
  if ($('#anthropicKey').value.trim()) secrets.anthropicKey = $('#anthropicKey').value.trim();
  if (Object.keys(secrets).length) await api('secrets', { method: 'PUT', body: secrets });
  await api('config', { method: 'PUT', body: { ai: { provider, openaiModel: $('#openaiModel').value.trim(), anthropicModel: $('#anthropicModel').value.trim(),
    anthropicEffort: $('#anthropicEffort').value, llmCorrection: $('#cfgLlmCorr').checked, autoSummarize: $('#cfgAutoSum').checked } } });
  toast('AI 설정을 저장했습니다.'); await refreshStatus(); loadSettings();
});
$('#testAi').addEventListener('click', async () => {
  $('#aiMsg').textContent = '확인 중…';
  try { const r = await api('ai/test', { body: {} }); $('#aiMsg').textContent = `✅ ${r.provider} · ${r.model} · ${(r.ms / 1000).toFixed(1)}초 · «${r.reply}»`; }
  catch (e) { $('#aiMsg').textContent = `⛔ ${e.message}`; }
});
$('#savePrompt').addEventListener('click', async () => { await api('prompts/summary', { method: 'PUT', body: { text: $('#promptText').value } }); toast('요약 형식을 저장했습니다.'); });
$('#resetPrompt').addEventListener('click', async () => { const r = await api('prompts/summary', { method: 'DELETE' }); $('#promptText').value = r.text; toast('기본 형식으로 되돌렸습니다.'); });

// ── 시작 ────────────────────────────────────────────────────────
(async function init() {
  await refreshStatus();
  try { state.config = await api('config'); } catch {}
  loadDevices();
  loadSessions();
  api('permissions').then((p) => { permCache = p; renderBanners(); }).catch(() => {});
  const h = location.hash;
  if (h.startsWith('#s=')) openSession(h.slice(3)).catch(() => {});
  else if (h === '#dict' || h === '#settings') showTab(h.slice(1));
  setInterval(refreshStatus, 1500);
  setInterval(() => {
    const busy = state.sessions.some((s) => s.status !== 'ready' && s.status !== 'failed' || (s.job && ['running', 'queued'].includes(s.job.status)));
    if (busy || Date.now() % 10000 < 2000) loadSessions();
  }, 2000);
  window.addEventListener('focus', () => { loadSessions(); loadDevices(true); });
  // 메뉴바 앱이 없을 때를 위한 보조 확인: 대시보드가 보이는 동안 10초마다 화면 목록을 새로 읽는다
  setInterval(() => { if (document.visibilityState === 'visible' && !state.status?.active) loadDevices(true); }, 10000);
})();
