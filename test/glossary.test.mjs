import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.MACREC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'macrec-test-'));
const G = await import('../server/lib/glossary.mjs');

test('띄어쓰기 교정과 단어 교정을 따로 뽑는다', () => {
  assert.deepEqual(G.diffPairs('오늘 노션 데이터 베이스를 클로드 코드로 열었다', '오늘 노션 데이터베이스를 Claude Code로 열었다'), [
    { from: '데이터 베이스', to: '데이터베이스' },
    { from: '클로드 코드', to: 'Claude Code' },
  ]);
});

test('문장 통째 수정은 사전 규칙으로 만들지 않는다', () => {
  assert.deepEqual(G.diffPairs('가 나 다 라 마 바', '하나 둘 셋 넷 다섯 여섯'), []);
});

test('치환 규칙은 긴 것부터 적용', () => {
  const g = { terms: [], ignore: [], replace: [{ from: '클로드', to: 'Claude' }, { from: '클로드 코드', to: 'Claude Code' }] };
  assert.equal(G.applyReplacements('클로드 코드와 클로드', g), 'Claude Code와 Claude');
});

test('무음 환각 문장을 거른다', () => {
  const g = { ...G.loadGlossary() };
  assert.equal(G.isHallucination('시청해 주셔서 감사합니다.', g), true);
  assert.equal(G.isHallucination('오늘 회의 시작하겠습니다', g), false);
});

test('승인한 제안은 규칙이 되고, 거절한 제안은 다시 올라오지 않는다', () => {
  G.addProposals([{ from: '노숀', to: 'Notion' }, { from: '지라', to: 'Jira' }], 'test', null);
  G.resolveProposal({ from: '노숀', to: 'Notion', accept: true });
  G.resolveProposal({ from: '지라', to: 'Jira', accept: false });
  const g = G.loadGlossary();
  assert.ok(g.replace.some((r) => r.from === '노숀' && r.to === 'Notion'));
  assert.equal(G.addProposals([{ from: '지라', to: 'Jira' }], 'test', null), 0);
});
