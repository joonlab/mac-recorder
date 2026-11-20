import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.MACREC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'macrec-test-'));
process.env.MACREC_RECORDINGS = fs.mkdtempSync(path.join(os.tmpdir(), 'macrec-rec-'));
const S = await import('../server/lib/sessions.mjs');

const base = { id: '20261118-140215', title: 'OO교육', sources: { video: true, mic: true, system: false } };

test('기본 규칙: 날짜_시간_제목 (시각은 녹화 ID 기준)', () => {
  assert.equal(S.ruleName(base, '{date}_{time}_{title}'), '20261118_1402_OO교육');
});
test('제목이 없으면 구분자와 함께 빠진다', () => {
  assert.equal(S.ruleName({ ...base, title: '' }, '{date}_{time}_{title}'), '20261118_1402');
  assert.equal(S.ruleName({ ...base, title: '' }, '{title}-{date}'), '20261118');
});
test('파일 이름에 못 쓰는 글자는 공백으로', () => {
  assert.equal(S.ruleName({ ...base, title: '웨비나: 데이터/1부' }, '{date}_{title}'), '20261118_웨비나 데이터 1부');
});
test('종류·소스 토큰', () => {
  assert.equal(S.ruleName({ ...base, kind: 'window', window: { app: 'Zoom' } }, '{kind}_{app}_{sources}'), '창_Zoom_창+마이크');
  assert.equal(S.ruleName({ ...base, kind: 'tab' }, '{date}-{hms}-{kind}'), '20261118-140215-탭');
});
test('모르는 토큰은 중괄호만 빠진다, 다 비면 ID', () => {
  assert.equal(S.ruleName(base, '{date}_{foo}'), '20261118_foo');
  assert.equal(S.ruleName({ ...base, title: '' }, '{title}'), base.id);
});
test('새 ID 는 같은 초에 여러 번 불러도 겹치지 않는다', () => {
  const ids = new Set(Array.from({ length: 5 }, () => S.newId()));
  assert.equal(ids.size, 5);
});
