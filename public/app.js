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
    state.status = s;
    renderControl();
    const pill = $('#pill');
    if (s.active) { pill.className = 'pill rec'; pill.textContent = `● 녹화 중 ${hms(s.active.elapsedSec)}`; }
    else { pill.className = 'pill'; pill.textContent = '대기 중'; }
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
  if (s && !s.whisper.ready) out.push(`<div class="banner warn"><span>전사 기능이 설치되지 않았습니다. 녹화는 됩니다. 전사가 필요하면 터미널에서 <code>./install.sh --with-transcribe</code></span></div>`);
  $('#banners').innerHTML = out.join('');
  $$('#banners [data-act="perm"]').forEach((b) => b.addEventListener('click', () => showTab('settings')));
}

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
  $('#recTitle').textContent = a ? `녹화 중 ${hms(a.elapsedSec)}${a.state === 'starting' ? ' (시작 중…)' : ''}` : '녹화 준비됨';
  const r = recOpts();
  for (const cb of $$('#srcChips input')) {
    if (document.activeElement !== cb) cb.checked = !!(a ? a.sources?.[cb.dataset.src] : r[cb.dataset.src]);
    cb.disabled = !!a;
  }
  $('#selDisplay').disabled = !!a || !r.video; $('#selMic').disabled = !!a || !r.mic;
  const parts = [];
  if (r.video) parts.push('화면을 영상(mp4)으로');
  if (r.mic || r.system) parts.push(`${[r.mic && '마이크', r.system && '시스템 소리'].filter(Boolean).join('와 ')}를 함께`);
  $('#srcHint').textContent = a ? '메뉴바 아이콘이나 ⌃⌥⌘R 로도 멈출 수 있습니다.'
    : (r.video ? `${parts.join(' ')} 녹화합니다.` : `${[r.mic && '마이크', r.system && '시스템 소리'].filter(Boolean).join('와 ')}만 오디오(m4a)로 녹음합니다.`)
      + (r.system ? '' : ' 화상회의 상대 목소리도 남기려면 «시스템 소리»를 켜세요.');
}
async function loadDevices(fresh = false) {
  try {
    state.devices = await api(`devices${fresh ? '?fresh=1' : ''}`);
    const r = recOpts();
    const ds = state.devices.displays || [];
    $('#selDisplay').innerHTML = `<option value="all">${ds.length > 1 ? `전체 화면 (${ds.length}개)` : '주 화면'}</option>`
      + (ds.length > 1 ? ds.map((d) => `<option value="${d.id}">${esc(d.name)}${d.main ? ' (주)' : ''}</option>`).join('') : '');
    $('#selDisplay').value = String(r.display || 'all');
    const ms = state.devices.mics || [];
    $('#selMic').innerHTML = `<option value="">시스템 기본 (${esc(ms.find((m) => m.default)?.name || '-')})</option>`
      + ms.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    $('#selMic').value = r.micId || '';
  } catch (e) { $('#selDisplay').innerHTML = '<option value="all">주 화면</option>'; }
}
async function saveRecord(patch) {
  await api('config', { method: 'PUT', body: { record: patch } });
  await refreshStatus();
}
$$('#srcChips input').forEach((cb) => cb.addEventListener('change', () => saveRecord({ [cb.dataset.src]: cb.checked })));
$('#selDisplay').addEventListener('change', (e) => saveRecord({ display: e.target.value }));
$('#selMic').addEventListener('change', (e) => saveRecord({ micId: e.target.value }));
$('#recBtn').addEventListener('click', async () => {
  const btn = $('#recBtn'); btn.disabled = true;
  try {
    if (state.status?.active) { await api('stop', { body: {} }); toast('녹화를 멈췄습니다. 파일을 정리하는 중입니다.'); }
    else { await api('start', { body: {} }); toast('녹화를 시작했습니다.'); }
  } catch (e) { toast(e.message, 6000); }
  btn.disabled = false;
  await refreshStatus(); loadSessions();
});

// ── 녹화 목록 ───────────────────────────────────────────────────
function jobTag(s) {
  const j = s.job;
  if (s.status === 'recording') return '<span class="tag err">● 녹화 중</span>';
  if (s.status === 'failed') return '<span class="tag err">실패</span>';
  if (j && (j.status === 'running' || j.status === 'queued')) return `<span class="tag run">${esc(j.step || '처리 중')}${j.progress != null ? ` ${j.progress}%` : ''}</span>`;
  const t = [];
  if (s.hasTranscript) t.push('<span class="tag ok">전사</span>');
  if (s.hasSummary) t.push('<span class="tag ok">요약</span>');
  if (j?.status === 'error') t.push('<span class="tag err">오류</span>');
  return t.join('');
}
function icon(s) { return s.sources?.video ? '🖥' : '🎙'; }
function srcText(s) {
  return [s.sources?.video && '화면', s.sources?.mic && '마이크', s.sources?.system && '시스템 소리'].filter(Boolean).join('·');
}
async function loadSessions() {
  try { state.sessions = (await api('sessions')).sessions; } catch { return; }
  renderSessions();
  if (state.open) { const s = state.sessions.find((x) => x.id === state.open); if (s) updateDrawerLive(s); }
}
function renderSessions() {
  const q = $('#search').value.trim().toLowerCase();
  const list = state.sessions.filter((s) => !q || `${s.title} ${s.id} ${when(s.createdAt)}`.toLowerCase().includes(q));
  if (!list.length) {
    $('#sessions').innerHTML = `<div class="empty">${q ? '검색 결과가 없습니다.' : '아직 녹화가 없습니다.<br>위의 빨간 버튼이나 메뉴바 아이콘으로 시작해 보세요.'}</div>`;
    return;
  }
  $('#sessions').innerHTML = list.map((s) => `
    <div class="sess" data-id="${s.id}">
      <div class="ic">${icon(s)}</div>
      <div style="min-width:0"><div class="t">${esc(s.title || when(s.createdAt))}</div>
        <div class="m">${s.title ? `${when(s.createdAt)} · ` : ''}${hms(s.durationSec)} · ${srcText(s)} · ${bytes(s.bytes)}</div></div>
      <div class="tagrow">${jobTag(s)}</div>
    </div>`).join('');
  $$('.sess').forEach((el) => el.addEventListener('click', () => openSession(el.dataset.id)));
}
$('#search').addEventListener('input', renderSessions);
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
  $('#dMeta').textContent = `${when(s.createdAt)} · ${hms(s.durationSec)} · ${srcText(s)} · ${bytes(s.bytes)}`;
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
  $('#sub-files').innerHTML = `<div class="files">${[...new Set(names)].map((n) => `<div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line)"><span class="mono">${esc(n)}</span><span class="row"><a href="${fileUrl(s.id, n, true)}">내려받기</a><button class="ghost" data-f="${esc(n)}">Finder</button></span></div>`).join('')}</div>
    <p class="muted">폴더: <span class="mono">${esc(s.dir)}</span></p>`;
  $$('#sub-files [data-f]').forEach((b) => b.addEventListener('click', () => api(`sessions/${s.id}/reveal`, { body: { file: b.dataset.f } })));
}
$$('.subtabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.subtabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('.sub').forEach((x) => x.classList.toggle('on', x.id === `sub-${b.dataset.sub}`));
}));
$('#dTitle').addEventListener('change', async (e) => {
  await api(`sessions/${detail.session.id}`, { method: 'PATCH', body: { title: e.target.value } });
  toast('제목을 바꿨습니다.'); loadSessions();
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
}
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
})();
