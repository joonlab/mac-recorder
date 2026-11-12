// AI 교정과 요약. 소리·영상은 보내지 않고 전사 글만 보낸다.
import fs from 'node:fs';
import path from 'node:path';
import { P, REPO, loadConfig } from './config.mjs';
import { complete, parseJSON } from './llm.mjs';
import { addProposals, loadGlossary } from './glossary.mjs';
import { readSegments, transcriptText, writeTranscript } from './transcribe.mjs';
import { hms } from './util.mjs';

export function promptTemplate(name) {
  const user = path.join(P.prompts, `${name}.md`);
  if (fs.existsSync(user)) return fs.readFileSync(user, 'utf8');
  return fs.readFileSync(path.join(REPO, 'templates', `${name}.md`), 'utf8');
}

function glossaryBlock() {
  const g = loadGlossary();
  const terms = g.terms.length ? g.terms.join(', ') : '(없음)';
  const rules = g.replace.length ? g.replace.map((r) => `${r.from} → ${r.to}`).join('\n') : '(없음)';
  return { terms, rules };
}

/** 사전·맥락을 기준으로 잘못 들은 말만 고친다. 고친 쌍은 «교정 제안»으로 쌓인다. */
export async function correctSession(session, dir, { onProgress } = {}) {
  const cfg = loadConfig();
  const segments = readSegments(dir);
  if (!segments.length) throw new Error('전사가 없습니다');
  const { terms, rules } = glossaryBlock();
  const system = promptTemplate('correct')
    .replaceAll('{{context}}', cfg.context || '(없음)').replaceAll('{{terms}}', terms).replaceAll('{{rules}}', rules);
  const CHUNK = 150;
  const fixed = segments.map((s) => ({ ...s }));
  const allChanges = [];
  const chunks = Math.ceil(segments.length / CHUNK);
  let model = '';
  for (let c = 0; c < chunks; c++) {
    const part = segments.slice(c * CHUNK, (c + 1) * CHUNK);
    const body = part.map((s, k) => `${c * CHUNK + k}|${s.speaker ? `${s.speaker}: ` : ''}${s.text}`).join('\n');
    const r = await complete({ system, prompt: `전사 줄(번호|내용):\n${body}` });
    model = r.model;
    let j;
    try { j = parseJSON(r.text); } catch { continue; } // 한 덩어리 실패는 건너뛴다(원문 유지)
    for (const l of j.lines || []) {
      const i = Number(l.i);
      if (!Number.isInteger(i) || i < c * CHUNK || i >= (c + 1) * CHUNK || typeof l.text !== 'string') continue;
      let t = l.text.trim();
      if (fixed[i].speaker && t.startsWith(`${fixed[i].speaker}:`)) t = t.slice(fixed[i].speaker.length + 1).trim();
      // 줄 길이가 크게 바뀌면 «교정»이 아니라 다시 쓴 것 → 버린다
      if (t && Math.abs(t.length - fixed[i].text.length) <= Math.max(12, fixed[i].text.length * 0.5)) fixed[i].text = t;
    }
    allChanges.push(...(j.changes || []));
    onProgress?.(Math.round(((c + 1) / chunks) * 100));
  }
  const label = `AI 교정(${model})`;
  const prev = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8')).corrected || []; } catch { return []; } })();
  writeTranscript(dir, session, fixed, { corrected: [...new Set([...prev, label])] });
  const added = addProposals(allChanges, 'ai', session.id);
  return { changed: fixed.filter((s, i) => s.text !== segments[i].text).length, proposals: added, model };
}

export async function summarizeSession(session, dir) {
  const cfg = loadConfig();
  const segments = readSegments(dir);
  if (!segments.length) throw new Error('전사가 없습니다');
  const dur = segments.length ? segments[segments.length - 1].end : 0;
  const prompt = promptTemplate('summary')
    .replaceAll('{{context}}', cfg.context || '(없음)')
    .replaceAll('{{date}}', new Date(session.createdAt).toLocaleString('ko-KR', { dateStyle: 'full', timeStyle: 'short' }))
    .replaceAll('{{duration}}', hms(dur))
    .replaceAll('{{title}}', session.title || '(제목 없음)')
    .replaceAll('{{transcript}}', transcriptText(segments));
  const r = await complete({ system: '당신은 회의·작업 녹화의 전사를 읽고 한국어로 정확하게 정리하는 비서입니다. 전사에 없는 내용은 지어내지 않습니다.', prompt });
  let md = r.text.trim();
  const m = md.match(/^#\s+(.+)$/m);
  const title = m ? m[1].trim().slice(0, 80) : '';
  md += `\n\n---\n_요약: ${r.provider} · ${r.model} · ${new Date().toLocaleString('ko-KR')}_\n`;
  fs.writeFileSync(path.join(dir, 'summary.md'), md);
  return { title, provider: r.provider, model: r.model };
}

/** «Claude Code 로 요약» — 사용자가 자기 Claude Code 세션에 붙여 넣을 지시문 */
export function claudeCodePrompt(session, dir) {
  return [
    `MacRecorder 녹화 «${session.title || session.id}»를 정리해 줘.`,
    `- 전사: ${path.join(dir, 'transcript.md')}`,
    `- 교정 사전: ${P.glossary}`,
    `- 요약 형식: ${fs.existsSync(path.join(P.prompts, 'summary.md')) ? path.join(P.prompts, 'summary.md') : path.join(REPO, 'templates', 'summary.md')}`,
    '',
    '1) 전사를 읽고 사전·맥락으로 잘못 들은 고유명사를 찾아 줘. 확실한 것만 «A → B» 목록으로 보여 주고,',
    `   내가 승인하면 \`macrec glossary propose "A" "B"\` 로 교정 제안에 올려 줘.`,
    `2) 요약 형식에 맞춰 정리해서 ${path.join(dir, 'summary.md')} 에 저장해 줘.`,
    '(mac-recorder 스킬이 설치돼 있으면 그 절차를 따라.)',
  ].join('\n');
}
