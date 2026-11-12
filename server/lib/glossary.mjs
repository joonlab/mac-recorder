// 교정 사전 — 쓸수록 정확해지는 부분.
//
//   terms    : 자주 나오는 고유명사(사람·제품·팀 이름). whisper 에 힌트로, AI 교정에 기준으로 들어간다.
//   replace  : «잘못 들은 말 → 맞는 말» 규칙. 전사 직후 그대로 치환한다(가장 확실한 교정).
//   ignore   : 무음 구간에서 whisper 가 지어내는 문장(«시청해 주셔서 감사합니다» 등). 이런 줄은 버린다.
//
// 제안(proposals): AI 교정·사용자의 직접 수정·Claude Code 가 발견한 «A→B» 를 모아 두고,
// 사용자가 승인하면 replace 규칙이 된다. 다음 녹화부터는 AI 없이도 바로 고쳐진다.
import fs from 'node:fs';
import { P, REPO, readJSON, writeJSON } from './config.mjs';
import path from 'node:path';

const DEFAULT_IGNORE = [
  '시청해 주셔서 감사합니다', '시청해주셔서 감사합니다', '구독과 좋아요', '좋아요와 구독', '다음 영상에서 만나요',
  'MBC 뉴스', 'KBS 뉴스', '자막 제공', '한글자막', '자막 by', 'Thank you for watching', '감사합니다.감사합니다',
];

export function loadGlossary() {
  let g = readJSON(P.glossary, null);
  if (!g) {
    g = readJSON(path.join(REPO, 'templates', 'glossary.example.json'), { terms: [], replace: [], ignore: [] });
    writeJSON(P.glossary, g);
  }
  return { terms: [], replace: [], rejected: [], ...g, ignore: uniq([...DEFAULT_IGNORE, ...(g.ignore || [])]) };
}
export function saveGlossary(g) {
  const clean = {
    terms: uniq((g.terms || []).map((t) => String(t).trim()).filter(Boolean)),
    replace: dedupeRules(g.replace || []),
    ignore: uniq((g.ignore || []).map((t) => String(t).trim()).filter(Boolean)),
    rejected: dedupeRules(g.rejected || []),
  };
  writeJSON(P.glossary, clean);
  return clean;
}
const uniq = (a) => [...new Set(a)];
function dedupeRules(rules) {
  const m = new Map();
  for (const r of rules) {
    const from = String(r.from || '').trim(), to = String(r.to ?? '').trim();
    if (!from || from === to) continue;
    m.set(from, { ...r, from, to });
  }
  return [...m.values()];
}

/** whisper --prompt 용 힌트(너무 길면 whisper 가 오히려 흔들려서 앞쪽 일부만). */
export function whisperPrompt(g = loadGlossary()) {
  const terms = uniq([...g.terms, ...g.replace.map((r) => r.to)]).filter(Boolean);
  let out = '';
  for (const t of terms) { if ((out + t).length > 220) break; out += (out ? ', ' : '') + t; }
  return out;
}

export function applyReplacements(text, g = loadGlossary()) {
  const rules = [...g.replace].sort((a, b) => b.from.length - a.from.length);
  let out = text;
  for (const r of rules) if (out.includes(r.from)) out = out.split(r.from).join(r.to);
  return out;
}
export function isHallucination(text, g = loadGlossary()) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return true;
  return g.ignore.some((p) => t.includes(p) && t.length <= p.length + 12);
}

// ── 제안 ───────────────────────────────────────────────────────────
export function loadProposals() { return readJSON(P.proposals, []); }

export function addProposals(pairs, source, sessionId) {
  const g = loadGlossary();
  const known = new Set([...g.replace, ...g.rejected].map((r) => `${r.from}\u0000${r.to}`));
  const list = loadProposals();
  const now = new Date().toISOString();
  let added = 0;
  for (const { from, to } of pairs) {
    const f = String(from || '').trim(), t = String(to || '').trim();
    if (!f || !t || f === t || f.length > 40 || t.length > 40) continue;
    if (known.has(`${f}\u0000${t}`) || g.replace.some((r) => r.from === f)) continue;
    const ex = list.find((p) => p.from === f && p.to === t);
    if (ex) {
      ex.count += 1; ex.lastSeen = now;
      if (sessionId && !ex.sessions.includes(sessionId)) ex.sessions.push(sessionId);
      if (!ex.sources.includes(source)) ex.sources.push(source);
    } else {
      list.push({ from: f, to: t, count: 1, sources: [source], sessions: sessionId ? [sessionId] : [], firstSeen: now, lastSeen: now });
      added += 1;
    }
  }
  writeJSON(P.proposals, list);
  try { fs.appendFileSync(P.learnLog, pairs.map((p) => JSON.stringify({ at: now, source, sessionId, ...p })).join('\n') + '\n'); } catch {}
  return added;
}

export function resolveProposal({ from, to, accept, editedTo }) {
  const list = loadProposals();
  const i = list.findIndex((p) => p.from === from && p.to === to);
  if (i < 0) throw new Error('제안을 찾을 수 없습니다');
  const [p] = list.splice(i, 1);
  writeJSON(P.proposals, list);
  const g = loadGlossary();
  if (accept) {
    const finalTo = (editedTo ?? p.to).trim();
    g.replace.push({ from: p.from, to: finalTo, addedAt: new Date().toISOString(), source: p.sources.join(',') });
    if (finalTo && /[A-Za-z가-힣]/.test(finalTo) && !g.terms.includes(finalTo)) g.terms.push(finalTo);
  } else {
    g.rejected.push({ from: p.from, to: p.to });
  }
  return saveGlossary(g);
}

// ── 사용자가 고친 전사에서 «A→B» 를 뽑는다 ─────────────────────────
const PARTICLES = ['으로', '에서', '께서', '한테', '이', '가', '은', '는', '을', '를', '의', '에', '로', '와', '과', '도', '랑'];

function trimParticle(from, to) {
  for (const p of PARTICLES) {
    if (from.endsWith(p) && to.endsWith(p) && from.length > p.length && to.length > p.length) {
      return [from.slice(0, -p.length).trim(), to.slice(0, -p.length).trim()];
    }
  }
  return [from, to];
}

/** 두 문장의 단어 단위 차이에서 짧은 치환 쌍만 뽑는다(문장 통째 수정은 사전 규칙감이 아니므로 버림). */
export function diffPairs(a, b) {
  const x = a.split(/\s+/).filter(Boolean), y = b.split(/\s+/).filter(Boolean);
  const n = x.length, m = y.length;
  if (n * m > 250000) return [];
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0, ra = [], rb = [];
  const emit = (fa, fb) => {
    if (!fa.length || !fb.length || fa.length > 4 || fb.length > 4) return;
    const [f, t] = trimParticle(fa.join(' '), fb.join(' '));
    if (f && t && f !== t && f.length <= 40 && t.length <= 40) out.push({ from: f, to: t });
  };
  // 한 덩어리 안에 «띄어쓰기만 다른 부분»이 있으면 먼저 떼어 낸다(예: «데이터 베이스를 클로드 코드로»)
  const split = (xa, xb) => {
    const ns = (arr) => arr.join('');
    for (let i = 1; i <= xa.length; i++) {
      for (let j = 1; j <= xb.length; j++) {
        if ((i > 1 || j > 1) && ns(xa.slice(0, i)) === ns(xb.slice(0, j))) {
          emit(xa.slice(0, i), xb.slice(0, j));
          return split(xa.slice(i), xb.slice(j));
        }
      }
    }
    emit(xa, xb);
  };
  const flush = () => { if (ra.length && rb.length) split(ra, rb); ra = []; rb = []; };
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { flush(); i++; j++; }
    else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) rb.push(y[j++]);
    else ra.push(x[i++]);
  }
  flush();
  return out;
}
