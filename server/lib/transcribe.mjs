// 로컬 전사 — whisper.cpp(whisper-cli). 소리는 이 맥 밖으로 나가지 않는다.
//
// 1) 녹화 파일의 오디오 트랙을 16kHz wav 로 뽑는다(시스템 소리·마이크 합치기, 또는 화자 구분용으로 따로)
// 2) whisper-cli 로 전사 — 교정 사전의 고유명사를 --prompt 힌트로 준다
// 3) 무음에서 지어낸 문장 제거 → 사전의 «A→B» 치환 → transcript.json / .md / .txt / .srt
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { P, loadConfig } from './config.mjs';
import { ENV, run, which, hms, pad } from './util.mjs';
import { probe } from './media.mjs';
import { applyReplacements, isHallucination, loadGlossary, whisperPrompt } from './glossary.mjs';

export const VAD_MODEL = 'ggml-silero-v5.1.2.bin';

export function findModel(name, minBytes = 1e6) {
  for (const d of [P.models, path.join(os.homedir(), '.whisper')]) {
    const f = path.join(d, name);
    try { if (fs.statSync(f).size > minBytes) return f; } catch {}
  }
  return null;
}
export function whisperStatus() {
  const cfg = loadConfig();
  const bin = which('whisper-cli');
  const model = findModel(cfg.transcribe.model);
  return { ready: !!(bin && model), bin, model, vad: findModel(VAD_MODEL, 1e5) };
}

async function extractWav(media, out, filter) {
  await run('ffmpeg', ['-y', '-v', 'error', '-i', media, ...filter, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out], { timeout: 3600_000 });
  return out;
}

function runWhisper(wav, outBase, { onProgress } = {}) {
  const cfg = loadConfig();
  const st = whisperStatus();
  if (!st.ready) throw new Error('whisper 가 설치되지 않았습니다. ./install.sh --with-transcribe 로 설치하세요.');
  const args = ['-m', st.model, '-f', wav, '-l', cfg.transcribe.language || 'ko', '-t', String(cfg.transcribe.threads || 4),
    '-oj', '-of', outBase, '-pp', '-sns'];
  const prompt = whisperPrompt();
  if (prompt) args.push('--prompt', prompt);
  if (st.vad) args.push('--vad', '-vm', st.vad);
  return new Promise((resolve, reject) => {
    const ch = spawn(st.bin, args, { env: ENV });
    let err = '';
    ch.stderr.on('data', (d) => {
      const s = String(d); err = (err + s).slice(-4000);
      const m = s.match(/progress =\s*(\d+)%/g);
      if (m && onProgress) onProgress(Number(m[m.length - 1].match(/\d+/)[0]));
    });
    ch.stdout.on('data', () => {});
    ch.on('error', reject);
    ch.on('close', (code) => {
      if (code !== 0) return reject(new Error(`whisper 실패(code ${code}): ${err.slice(-600)}`));
      try {
        const j = JSON.parse(fs.readFileSync(`${outBase}.json`, 'utf8'));
        resolve((j.transcription || []).map((t) => ({
          start: (t.offsets?.from || 0) / 1000, end: (t.offsets?.to || 0) / 1000, text: String(t.text || '').trim(),
        })));
      } catch (e) { reject(new Error(`whisper 결과를 읽지 못했습니다: ${e.message}`)); }
    });
  });
}

/** 녹화 하나를 전사한다. 결과 세그먼트: [{start, end, speaker?, text}] */
export async function transcribeSession(session, dir, { onProgress } = {}) {
  const cfg = loadConfig();
  const media = path.join(dir, session.media);
  if (!fs.existsSync(media)) throw new Error('녹화 파일이 없습니다');
  const info = await probe(media);
  const n = info.audioTracks.length;
  if (!n) throw new Error('이 녹화에는 소리 트랙이 없습니다(화면만 녹화).');
  const work = path.join(dir, '.work');
  fs.mkdirSync(work, { recursive: true });
  const g = loadGlossary();

  // 트랙 순서: 캡처 앱이 시스템 소리 → 마이크 순으로 추가한다
  const labels = [];
  if (session.sources?.system) labels.push('상대');
  if (session.sources?.mic) labels.push('나');

  let raw = [];
  try {
    if (cfg.transcribe.splitSpeakers && n >= 2) {
      for (let i = 0; i < n; i++) {
        const wav = await extractWav(media, path.join(work, `track${i}.wav`), ['-map', `0:a:${i}`]);
        const segs = await runWhisper(wav, path.join(work, `track${i}`), {
          onProgress: (p) => onProgress?.(Math.round((i * 100 + p) / n)),
        });
        raw.push(...segs.map((s) => ({ ...s, speaker: labels[i] || `트랙${i + 1}` })));
      }
      raw.sort((a, b) => a.start - b.start);
    } else {
      const filter = n >= 2
        ? ['-filter_complex', `${Array.from({ length: n }, (_, i) => `[0:a:${i}]`).join('')}amix=inputs=${n}:duration=longest:normalize=0[a]`, '-map', '[a]']
        : ['-map', '0:a:0'];
      const wav = await extractWav(media, path.join(work, 'mix.wav'), filter);
      raw = await runWhisper(wav, path.join(work, 'mix'), { onProgress });
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  const kept = raw.filter((s) => !isHallucination(s.text, g));
  const segments = kept.map((s) => ({ ...s, text: applyReplacements(s.text, g) }));
  fs.writeFileSync(path.join(dir, 'transcript.whisper.json'), JSON.stringify(kept, null, 2));
  writeTranscript(dir, session, segments, { engine: `whisper.cpp ${cfg.transcribe.model.replace(/^ggml-|\.bin$/g, '')}` });
  return segments;
}

export function readSegments(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8')).segments || []; } catch { return []; }
}

const srtTime = (t) => {
  const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${String(ms % 1000).padStart(3, '0')}`;
};

export function writeTranscript(dir, session, segments, meta = {}) {
  const prev = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8')); } catch { return {}; } })();
  const doc = { version: 1, engine: meta.engine || prev.engine, corrected: meta.corrected ?? prev.corrected ?? [], editedAt: meta.editedAt ?? prev.editedAt ?? null, segments };
  fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(doc, null, 2));
  const line = (s) => `[${hms(s.start)}] ${s.speaker ? `${s.speaker}: ` : ''}${s.text}`;
  const title = session.title || session.id;
  fs.writeFileSync(path.join(dir, 'transcript.md'),
    `# ${title} — 전사\n\n- 녹화: ${session.id}\n- 엔진: ${doc.engine || '-'}${doc.corrected.length ? ` + ${doc.corrected.join(', ')}` : ''}\n\n${segments.map(line).join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'transcript.txt'), segments.map((s) => (s.speaker ? `${s.speaker}: ` : '') + s.text).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'transcript.srt'), segments.map((s, i) =>
    `${i + 1}\n${srtTime(s.start)} --> ${srtTime(Math.max(s.end, s.start + 0.5))}\n${s.speaker ? `${s.speaker}: ` : ''}${s.text}\n`).join('\n'));
  return doc;
}

export function transcriptText(segments) {
  return segments.map((s) => `[${hms(s.start)}] ${s.speaker ? `${s.speaker}: ` : ''}${s.text}`).join('\n');
}
