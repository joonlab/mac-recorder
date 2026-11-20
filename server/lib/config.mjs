// 경로·설정·비밀값. 모든 사용자 데이터는 ~/.mac-recorder 와 녹화 폴더(기본 ~/Movies/MacRecorder) 두 곳에만 둔다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const HOME = process.env.MACREC_HOME || path.join(os.homedir(), '.mac-recorder');
export const VERSION = (() => { try { return fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim(); } catch { return '0.0.0'; } })();

export const P = {
  config: path.join(HOME, 'config.json'),
  secrets: path.join(HOME, 'secrets.json'),
  glossary: path.join(HOME, 'glossary.json'),
  proposals: path.join(HOME, 'proposals.json'),
  learnLog: path.join(HOME, 'corrections.jsonl'),
  prompts: path.join(HOME, 'prompts'),
  models: path.join(HOME, 'models'),
  logs: path.join(HOME, 'logs'),
  active: path.join(HOME, 'active.json'),
  jobs: path.join(HOME, 'jobs'),
};

export const DEFAULTS = {
  port: 7931,
  host: '127.0.0.1',
  // 127.0.0.1 로 열어도 Tailscale serve 같은 프록시로 들어오면 Host 헤더가 달라진다. 허용할 이름(«*.ts.net» 처럼 와일드카드 가능)
  allowedHosts: [],
  recordingsDir: path.join(os.homedir(), 'Movies', 'MacRecorder'),
  captureApp: path.join(os.homedir(), 'Applications', 'MacRecorder Capture.app'),
  record: { video: true, mic: true, system: false, display: 'all', micId: '', width: 1920, fps: 30 },
  transcribe: {
    auto: true, // 녹화가 끝나면 자동 전사(whisper 가 설치돼 있을 때만)
    language: 'ko',
    model: 'ggml-large-v3-turbo-q8_0.bin',
    splitSpeakers: false, // 마이크(나)·시스템 소리(상대)를 따로 전사해 화자 표시. 이어폰을 쓸 때 정확
    threads: Math.max(2, Math.min(8, os.cpus().length - 2)),
  },
  ai: {
    provider: 'none', // none | claude-code | openai | anthropic | claude-cli
    openaiModel: 'gpt-5.5',
    anthropicModel: 'claude-opus-5-5',
    anthropicEffort: 'medium',
    claudeCliPath: '',
    autoSummarize: false,
    llmCorrection: true, // 요약 제공자가 있으면 요약 전에 사전·맥락으로 전사 교정
  },
  // 녹화 폴더 이름 규칙. 토큰 {date} {time} {hms} {title} {kind} {sources} {app} {id}. 내려받기 파일 이름도 이 이름을 쓴다
  naming: { pattern: '{date}_{time}_{title}' },
  context: '', // 내 맥락: 소속·자주 나오는 사람/제품 이름 등. 교정·요약 프롬프트에 들어간다
};

export function ensureHome() {
  for (const d of [HOME, P.prompts, P.models, P.logs, P.jobs]) fs.mkdirSync(d, { recursive: true });
}

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
export function writeJSON(p, obj, mode) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', mode ? { mode } : undefined);
  fs.renameSync(tmp, p);
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  const c = merge(DEFAULTS, readJSON(P.config, {}));
  if (process.env.MACREC_PORT) c.port = Number(process.env.MACREC_PORT);
  if (process.env.MACREC_RECORDINGS) c.recordingsDir = process.env.MACREC_RECORDINGS;
  c.recordingsDir = c.recordingsDir.replace(/^~(?=\/|$)/, os.homedir());
  c.captureApp = c.captureApp.replace(/^~(?=\/|$)/, os.homedir());
  return c;
}

// 설정 저장은 사용자가 바꾼 값만 남긴다(기본값이 바뀌면 따라가도록)
export function saveConfig(patch) {
  const cur = readJSON(P.config, {});
  const next = merge(cur, patch);
  writeJSON(P.config, next);
  return loadConfig();
}

export function loadSecrets() {
  const s = readJSON(P.secrets, {});
  return {
    openaiKey: process.env.OPENAI_API_KEY || s.openaiKey || '',
    anthropicKey: process.env.ANTHROPIC_API_KEY || s.anthropicKey || '',
    fromEnv: { openai: !!process.env.OPENAI_API_KEY, anthropic: !!process.env.ANTHROPIC_API_KEY },
  };
}
export function saveSecrets(patch) {
  const cur = readJSON(P.secrets, {});
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '') delete cur[k]; else if (typeof v === 'string') cur[k] = v.trim();
  }
  writeJSON(P.secrets, cur, 0o600);
  fs.chmodSync(P.secrets, 0o600);
}
export const mask = (k) => (k ? `${k.slice(0, 6)}…${k.slice(-4)}` : '');

export { readJSON };
