// offscreen 문서 — 탭마다 MediaRecorder 하나. 여러 탭을 동시에 녹화한다.
// 녹화 조각(2초)을 순서대로 MacRecorder 서버에 올리고, 5초마다 상태를 보내 대시보드의 명령(일시정지·정지)을 받는다.
import { apiJSON } from './common.js';

const SLICE_MS = 2000;
const HEARTBEAT_MS = 5000;
const VIDEO_BPS = 4_000_000;
const MIME_CANDIDATES = [
  'video/webm;codecs=h264,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
const pickMime = () => MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';

const recs = new Map(); // tabId → Rec
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toBg = (msg) => chrome.runtime.sendMessage({ target: 'bg', ...msg }).catch(() => {});

class Rec {
  constructor(o) {
    Object.assign(this, o);
    this.seq = 0;
    this.queue = [];
    this.uploading = false;
    this.events = [];
    this.pausedTotal = 0;   // ms
    this.pausedAt = null;
    this.startedMs = 0;
    this.state = 'starting';
    this.error = null;
    this.uploadDelay = false;
    this.stopping = null;
  }

  recordedSec() {
    if (!this.startedMs) return 0;
    const now = this.pausedAt ?? Date.now();
    return Math.max(0, (now - this.startedMs - this.pausedTotal) / 1000);
  }

  report() {
    return toBg({
      type: 'update', tabId: this.tabId,
      rec: { id: this.id, state: this.state, recordedSec: Math.round(this.recordedSec()), error: this.error, uploadDelay: this.uploadDelay, mimeType: this.mimeType },
    });
  }

  event(type) {
    this.events.push({ type, at: new Date().toISOString(), t: Math.round(this.recordedSec() * 1000) / 1000 });
  }

  async open() {
    // 1) 소스: 탭 캡처(또는 시험용 합성 스트림)
    if (this.source === 'synthetic') this.src = syntheticStream();
    else {
      const m = { chromeMediaSource: 'tab', chromeMediaSourceId: this.streamId };
      this.src = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: m },
        video: { mandatory: { ...m, maxFrameRate: 30, ...(this.size ? { minWidth: this.size.width, maxWidth: this.size.width, minHeight: this.size.height, maxHeight: this.size.height } : {}) } },
      });
    }
    // 2) 소리: 탭 소리는 계속 들리게 스피커로 다시 보내고, 녹화용으로는 마이크와 섞는다
    this.ctx = new AudioContext();
    const dest = this.ctx.createMediaStreamDestination();
    if (this.src.getAudioTracks().length) {
      const tabAudio = this.ctx.createMediaStreamSource(new MediaStream(this.src.getAudioTracks()));
      if (this.source !== 'synthetic') tabAudio.connect(this.ctx.destination);
      tabAudio.connect(dest);
    }
    if (this.mic) {
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: this.micId ? { deviceId: { exact: this.micId } } : true,
        });
      } catch (e) {
        // 고른 마이크가 빠졌으면 기본 마이크로
        if (this.micId) {
          try { this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); this.event('mic-fallback'); } catch {}
        }
        if (!this.micStream) throw new Error(`마이크를 열지 못했습니다(${e.name}). 확장 팝업에서 «마이크 허용»을 먼저 눌러 주세요.`);
      }
      this.ctx.createMediaStreamSource(this.micStream).connect(dest);
    }
    const tracks = [...this.src.getVideoTracks(), ...dest.stream.getAudioTracks()];
    this.out = new MediaStream(tracks);

    // 탭이 닫히거나 캡처가 끊기면 자동 정지
    for (const t of this.src.getTracks()) t.addEventListener('ended', () => { if (!this.stopping) { this.event('ended'); this.stop('ended'); } });

    // 3) 서버에 녹화 만들기
    this.mimeType = pickMime();
    const r = await apiJSON(this.server, '/api/tabs/start', { title: this.title, url: this.url, mic: !!this.mic, mimeType: this.mimeType });
    this.id = r.id;

    // 4) 녹화 시작
    this.rec = new MediaRecorder(this.out, { mimeType: this.mimeType || undefined, videoBitsPerSecond: VIDEO_BPS, audioBitsPerSecond: 128_000 });
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) { this.queue.push(e.data); this.pump(); } };
    this.rec.start(SLICE_MS);
    this.startedMs = Date.now();
    this.state = 'recording';
    this.timer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.report();
  }

  /** 조각을 하나씩 순서대로 올린다. 3번 실패하면 잠시 쉬었다가 같은 조각부터 다시(조각을 버리지 않는다). */
  async pump() {
    if (this.uploading) return;
    this.uploading = true;
    try {
      while (this.queue.length) {
        const blob = this.queue[0];
        let ok = false;
        for (let i = 0; i < 3 && !ok; i++) {
          try {
            const r = await fetch(`${this.server}/api/tabs/${encodeURIComponent(this.id)}/chunk?seq=${this.seq}`, {
              method: 'POST', headers: { 'X-Macrec': '1', 'Content-Type': 'application/octet-stream' }, body: blob,
            });
            if (r.status === 404) { this.fail('MacRecorder 에서 이 녹화를 찾을 수 없습니다(지워졌을 수 있음).'); return; }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const j = await r.json().catch(() => ({}));
            ok = true;
            this.handleCmd(j.cmd);
          } catch { await sleep(500 * (i + 1)); }
        }
        if (!ok) {
          if (!this.uploadDelay) { this.uploadDelay = true; this.report(); }
          await sleep(3000);
          continue;
        }
        if (this.uploadDelay) { this.uploadDelay = false; this.report(); }
        this.queue.shift();
        this.seq += 1;
      }
    } finally { this.uploading = false; }
    if (this.queue.length) this.pump();
  }

  async heartbeat() {
    if (!this.id || this.state === 'error') return;
    try {
      const r = await fetch(`${this.server}/api/tabs/${encodeURIComponent(this.id)}/state`, {
        method: 'POST', headers: { 'X-Macrec': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: this.state === 'paused', recordedSec: Math.round(this.recordedSec()) }),
      });
      if (r.status === 404) return this.fail('MacRecorder 에서 이 녹화를 찾을 수 없습니다(지워졌을 수 있음).');
      const j = await r.json().catch(() => ({}));
      this.handleCmd(j.cmd);
    } catch { /* 서버가 잠깐 꺼져도 녹화는 계속 */ }
    this.report();
  }

  handleCmd(cmd) {
    if (cmd === 'pause') this.pause();
    else if (cmd === 'resume') this.resume();
    else if (cmd === 'stop') this.stop('dashboard');
  }

  pause() {
    if (this.state !== 'recording') return;
    this.rec.pause();
    this.pausedAt = Date.now();
    this.event('paused');
    this.state = 'paused';
    this.report();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.pausedTotal += Date.now() - this.pausedAt;
    this.pausedAt = null;
    this.rec.resume();
    this.event('resumed');
    this.state = 'recording';
    this.report();
  }

  /** 정지: 마지막 조각까지 올린 뒤 서버에 끝났다고 알린다 */
  stop(reason = 'user') {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (this.state === 'paused') { this.pausedTotal += Date.now() - this.pausedAt; this.pausedAt = null; }
      const recordedSec = this.recordedSec();
      this.state = 'stopping';
      this.report();
      clearInterval(this.timer);
      if (this.rec && this.rec.state !== 'inactive') {
        await new Promise((res) => { this.rec.addEventListener('stop', res, { once: true }); this.rec.stop(); });
      }
      // 업로드가 다 끝날 때까지(서버가 꺼져 있으면 최대 10분 기다린다)
      const until = Date.now() + 10 * 60_000;
      while ((this.queue.length || this.uploading) && Date.now() < until && this.state !== 'error') { this.pump(); await sleep(300); }
      this.release();
      if (this.state === 'error') return;
      try {
        await apiJSON(this.server, `/api/tabs/${encodeURIComponent(this.id)}/stop`, {
          recordedSec: Math.round(recordedSec * 10) / 10, pausedTotalSec: Math.round(this.pausedTotal / 100) / 10, events: this.events, reason,
        });
      } catch (e) { return this.fail(`녹화를 마무리하지 못했습니다: ${e.message}`); }
      recs.delete(this.tabId);
      toBg({ type: 'removed', tabId: this.tabId });
    })();
    return this.stopping;
  }

  fail(msg) {
    this.error = msg;
    this.state = 'error';
    clearInterval(this.timer);
    try { if (this.rec && this.rec.state !== 'inactive') this.rec.stop(); } catch {}
    this.queue = [];
    this.release();
    recs.delete(this.tabId);
    this.report();
  }

  release() {
    for (const s of [this.src, this.micStream]) s?.getTracks().forEach((t) => t.stop());
    this.synthStop?.();
    try { this.ctx?.close(); } catch {}
  }
}

/** 시험용 소스: 움직이는 캔버스 + 440Hz 소리 */
function syntheticStream() {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  const g = canvas.getContext('2d');
  let n = 0;
  const iv = setInterval(() => { g.fillStyle = `hsl(${(n += 7) % 360} 70% 50%)`; g.fillRect(0, 0, 640, 360); g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText(String(n), 40, 200); }, 33);
  const v = canvas.captureStream(30);
  const ac = new AudioContext();
  const o = ac.createOscillator(); const d = ac.createMediaStreamDestination(); o.connect(d); o.start();
  const s = new MediaStream([...v.getVideoTracks(), ...d.stream.getAudioTracks()]);
  syntheticStream.last = () => { clearInterval(iv); try { ac.close(); } catch {} };
  return s;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.target !== 'offscreen') return false;
  (async () => {
    const { type, tabId } = msg;
    if (type === 'start') {
      if (recs.has(tabId)) throw new Error('이 탭은 이미 녹화 중입니다.');
      const r = new Rec({ tabId, size: msg.size, streamId: msg.streamId, title: msg.title, url: msg.url, mic: msg.mic, micId: msg.micId, server: msg.server, source: msg.source });
      recs.set(tabId, r);
      try { await r.open(); if (r.source === 'synthetic') r.synthStop = syntheticStream.last; }
      catch (e) { recs.delete(tabId); r.release(); throw e; }
      return { id: r.id, mimeType: r.mimeType };
    }
    const r = recs.get(tabId);
    if (!r) throw new Error('녹화 중인 탭이 아닙니다.');
    if (type === 'pause') r.pause();
    else if (type === 'resume') r.resume();
    else if (type === 'stop') { r.stop(msg.reason || 'user'); }
    return {};
  })().then((x) => reply({ ok: true, ...(x || {}) }), (e) => reply({ ok: false, error: e.message }));
  return true;
});
