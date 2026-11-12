// 요약·교정에 쓰는 AI 제공자. 사용자가 설정에서 하나를 고른다.
//   openai     — OpenAI API 키 (Chat Completions)
//   anthropic  — Anthropic API 키 (공식 SDK)
//   claude-cli — 이 맥에 로그인된 Claude Code(`claude -p`). 별도 키 없이 본인 구독으로 실행
//   claude-code— 서버가 직접 부르지 않는다. 대시보드가 Claude Code 세션에 붙여 넣을 지시문을 만들어 준다
//   none       — AI 사용 안 함(전사까지만)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, loadSecrets } from './config.mjs';
import { ENV, which } from './util.mjs';

// 정책상 거절(refusal) 시 서버가 다른 모델로 이어 주는 기능을 지원하는 모델
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export function findClaudeCli() {
  const cfg = loadConfig();
  const cands = [cfg.ai.claudeCliPath, which('claude'), path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].filter(Boolean);
  for (const c of cands) { try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {} }
  return null;
}

/** 서버가 직접 부를 수 있는 제공자인지와 그 이유 */
export function providerStatus(cfg = loadConfig()) {
  const sec = loadSecrets();
  const p = cfg.ai.provider;
  if (p === 'openai') return { provider: p, runnable: !!sec.openaiKey, reason: sec.openaiKey ? '' : 'OpenAI API 키가 없습니다' };
  if (p === 'anthropic') return { provider: p, runnable: !!sec.anthropicKey, reason: sec.anthropicKey ? '' : 'Anthropic API 키가 없습니다' };
  if (p === 'claude-cli') { const c = findClaudeCli(); return { provider: p, runnable: !!c, reason: c ? '' : 'claude 명령을 찾지 못했습니다' }; }
  if (p === 'claude-code') return { provider: p, runnable: false, reason: 'Claude Code 세션에서 직접 요약합니다' };
  return { provider: 'none', runnable: false, reason: 'AI 사용 안 함' };
}

export async function complete({ system, prompt, maxTokens = 16000 }) {
  const cfg = loadConfig();
  const sec = loadSecrets();
  const p = cfg.ai.provider;
  if (p === 'openai') return openai(sec.openaiKey, cfg.ai.openaiModel, system, prompt);
  if (p === 'anthropic') return anthropic(sec.anthropicKey, cfg.ai.anthropicModel, cfg.ai.anthropicEffort, system, prompt, maxTokens);
  if (p === 'claude-cli') return claudeCli(system, prompt);
  throw new Error(providerStatus(cfg).reason || 'AI 제공자가 설정되지 않았습니다');
}

async function openai(key, model, system, prompt) {
  if (!key) throw new Error('OpenAI API 키가 없습니다');
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI 오류 ${r.status}: ${j.error?.message || 'unknown'}`);
  return { text: j.choices?.[0]?.message?.content || '', model: j.model || model, provider: 'openai' };
}

async function anthropic(key, model, effort, system, prompt, maxTokens) {
  if (!key) throw new Error('Anthropic API 키가 없습니다');
  const client = new Anthropic({ apiKey: key });
  const params = {
    model,
    max_tokens: Math.max(maxTokens, 32000),
    system,
    messages: [{ role: 'user', content: prompt }],
    ...(effort ? { output_config: { effort } } : {}),
  };
  if (FALLBACK_MODELS.has(model)) { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
  // 긴 전사는 응답도 길어서 스트리밍으로 받는다(HTTP 시간 초과 방지)
  const stream = client.beta.messages.stream(params);
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error(`Anthropic 이 요청을 거절했습니다(${msg.stop_details?.category || 'refusal'})`);
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (msg.stop_reason === 'max_tokens') throw new Error('응답이 길이 제한에서 잘렸습니다');
  return { text, model: msg.model || model, provider: 'anthropic' };
}

function claudeCli(system, prompt) {
  const bin = findClaudeCli();
  if (!bin) throw new Error('claude 명령을 찾지 못했습니다(Claude Code 설치 필요)');
  return new Promise((resolve, reject) => {
    // 도구 없이 글만 쓰게 한다. 작업 폴더는 홈 — 프로젝트 설정이 끼어들지 않게
    const ch = spawn(bin, ['-p', '--output-format', 'text', '--append-system-prompt', system, '--tools', ''], {
      cwd: os.tmpdir(), env: ENV, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const t = setTimeout(() => { ch.kill('SIGTERM'); reject(new Error('Claude Code 응답 시간 초과(20분)')); }, 20 * 60_000);
    ch.stdout.on('data', (d) => { out += d; });
    ch.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    ch.on('error', (e) => { clearTimeout(t); reject(e); });
    ch.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(`claude 실패(code ${code}): ${err || out.slice(-500)}`));
      resolve({ text: out.trim(), model: 'claude-code', provider: 'claude-cli' });
    });
    ch.stdin.end(prompt);
  });
}

/** 응답에서 JSON 객체를 꺼낸다(코드블록·앞뒤 설명이 붙어도). */
export function parseJSON(text) {
  const s = text.replace(/```(?:json)?/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('AI 응답에 JSON 이 없습니다');
  return JSON.parse(s.slice(a, b + 1));
}
