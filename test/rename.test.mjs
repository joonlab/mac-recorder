// 폴더·파일 이름 바꾸기 시험 — 임시 폴더 안에 가짜 녹화를 만들어서만 시험한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.MACREC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'macrec-test-'));
const REC = fs.mkdtempSync(path.join(os.tmpdir(), 'macrec-rec-'));
process.env.MACREC_RECORDINGS = REC;
const S = await import('../server/lib/sessions.mjs');
const { saveConfig } = await import('../server/lib/config.mjs');

let n = 0;
/** 끝난 녹화 하나를 흉내 낸다(파일 내용은 이름표만) */
function fake({ title = '', files = ['recording.mp4', 'transcript.md', 'transcript.txt', 'transcript.srt', 'transcript.json'], folder } = {}) {
  const id = `20261127-10${String(n).padStart(2, '0')}00`; n++;
  const name = folder || id;
  const dir = path.join(REC, name);
  fs.mkdirSync(dir);
  for (const f of files) fs.writeFileSync(path.join(dir, f), f);
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ id, title, media: 'recording.mp4', status: 'ready', sources: { video: true, mic: true }, folderName: name }));
  return id;
}
const ls = (id) => fs.readdirSync(S.sessionDir(id)).sort();
const read = (id, f) => fs.readFileSync(path.join(S.sessionDir(id), f), 'utf8');

test('publicNames: 재생 파일이 폴더 이름을, 나머지는 종류를 붙인다', () => {
  const m = S.publicNames('X', new Set(['recording.mp4', 'recording_mixed.mp4', 'recording_all.mp4', 'display-2.mp4', 'transcript.md', 'summary.md']), 'recording.mp4');
  assert.deepEqual(m, {
    'recording.mp4': 'X_원본.mp4', 'recording_mixed.mp4': 'X_주화면.mp4', 'recording_all.mp4': 'X.mp4',
    'display-2.mp4': 'X_화면2.mp4', 'transcript.md': 'X_전사.md', 'summary.md': 'X_요약.md',
  });
  assert.equal(new Set(Object.values(m)).size, 6, '이름이 겹치지 않는다');
});

test('titleFromFolder: 앞의 날짜·시간을 뗀다', () => {
  assert.equal(S.titleFromFolder('20261125_1445_OO교육'), 'OO교육');
  assert.equal(S.titleFromFolder('20261125-130619'), '');
  assert.equal(S.titleFromFolder('20261125 주간회의'), '주간회의');
  assert.equal(S.titleFromFolder('그냥 이름'), '그냥 이름');
});

test('설정이 꺼져 있으면 폴더 이름만 바뀌고 파일은 그대로', () => {
  saveConfig({ naming: { files: false } });
  const id = fake();
  S.updateSession(id, { title: '주간회의' });
  const r = S.applyNaming(id);
  assert.equal(r.name, '20261127_1000_주간회의');
  assert.ok(ls(id).includes('recording.mp4'));
});

test('설정을 켜면 파일 이름도 폴더 이름을 따른다 · 고정 이름으로도 찾힌다', () => {
  saveConfig({ naming: { files: true } });
  const id = fake({ title: 'OO교육' });
  S.applyNaming(id);
  const base = path.basename(S.sessionDir(id));
  assert.equal(base, '20261127_1001_OO교육');
  assert.deepEqual(ls(id), ['20261127_1001_OO교육.mp4', '20261127_1001_OO교육_전사.md', '20261127_1001_OO교육_전사.srt', '20261127_1001_OO교육_전사.txt', 'session.json', 'transcript.json']);
  assert.equal(fs.readFileSync(S.safeFile(id, 'recording.mp4'), 'utf8'), 'recording.mp4');
  const d = S.describe(S.readSession(id));
  assert.equal(d.hasTranscript, true);
  assert.equal(d.fileNames['transcript.md'], '20261127_1001_OO교육_전사.md');
  assert.equal(S.downloadName(id, 'transcript.md'), '20261127_1001_OO교육_전사.md');
});

test('제목을 다시 고치면 폴더·파일 이름이 한 번에 바뀐다', () => {
  const id = fake({ title: '첫 제목' });
  S.applyNaming(id);
  S.updateSession(id, { title: '둘째 제목' });
  S.applyNaming(id);
  assert.equal(path.basename(S.sessionDir(id)), '20261127_1002_둘째 제목');
  assert.ok(ls(id).includes('20261127_1002_둘째 제목.mp4'));
  assert.ok(!ls(id).some((f) => f.includes('첫 제목')));
});

test('처리 전 고정 이름으로 되돌리고(toCanonical), 끝나면 다시 맞춘다', () => {
  const id = fake({ title: '처리' });
  S.applyNaming(id);
  S.toCanonical(id);
  assert.ok(ls(id).includes('recording.mp4') && ls(id).includes('transcript.md'));
  fs.writeFileSync(path.join(S.sessionDir(id), 'summary.md'), '요약');   // 처리 중 새로 생긴 파일
  S.applyNaming(id);
  assert.equal(read(id, '20261127_1003_처리_요약.md'), '요약');
  assert.ok(!ls(id).includes('recording.mp4'));
});

test('고정 이름 파일이 새로 생기면(요약 다시 저장) 목록을 읽을 때 예전 것을 대신한다', () => {
  saveConfig({ naming: { files: true } });
  const id = fake({ title: '새요약', files: ['recording.mp4', 'summary.md'] });
  S.applyNaming(id);
  fs.writeFileSync(path.join(S.sessionDir(id), 'summary.md'), '새 요약');
  S.listSessions();
  assert.deepEqual(ls(id).filter((f) => f.endsWith('_요약.md') || f === 'summary.md'), ['20261127_1004_새요약_요약.md']);
  assert.equal(read(id, '20261127_1004_새요약_요약.md'), '새 요약');
});

test('같은 이름의 남의 파일은 덮어쓰지 않는다', () => {
  const id = fake({ title: '남의파일', files: ['recording.mp4', 'transcript.md'] });
  S.applyNaming(id);
  // 사용자가 폴더에 같은 이름 파일을 넣었다고 치고, 전사 파일을 고정 이름으로 돌린 뒤 다시 맞춘다
  S.toCanonical(id);
  fs.writeFileSync(path.join(S.sessionDir(id), '20261127_1005_남의파일_전사.md'), '내 메모');
  S.applyNaming(id);
  assert.equal(read(id, '20261127_1005_남의파일_전사.md'), '내 메모');
  assert.equal(read(id, 'transcript.md'), 'transcript.md');
});

test('파일 이름을 못 바꾸면 폴더 이름까지 원래대로 되돌린다', () => {
  const id = fake({ title: '원래' });
  S.applyNaming(id);
  const before = S.sessionDir(id), beforeFiles = ls(id);
  S.updateSession(id, { title: '실패해야 함' });
  fs.chmodSync(before, 0o555);   // 폴더 안 파일 이름을 못 바꾸게
  try {
    assert.throws(() => S.applyNaming(id), /원래 이름으로/);
    assert.equal(S.sessionDir(id), before);
    assert.ok(fs.existsSync(before));
    assert.ok(!fs.existsSync(path.join(REC, '20261127_1006_실패해야 함')));
    assert.deepEqual(ls(id), beforeFiles);
  } finally { fs.chmodSync(before, 0o755); }
});

test('Finder 에서 폴더 이름을 바꾸면 제목이 따라가고, 그 이름을 지킨다', () => {
  const id = fake({ title: '처음' });
  S.applyNaming(id);
  fs.renameSync(S.sessionDir(id), path.join(REC, '20261127_1007_Finder에서 바꿈'));
  const s = S.listSessions().find((x) => x.id === id);
  assert.equal(s.title, 'Finder에서 바꿈');
  assert.equal(s.folder, '20261127_1007_Finder에서 바꿈');
  assert.equal(s.nameLocked, true);
  assert.ok(ls(id).includes('20261127_1007_Finder에서 바꿈.mp4'), '파일 이름도 따라간다');
  // 규칙과 다른 이름이어도 되돌리지 않는다
  fs.renameSync(S.sessionDir(id), path.join(REC, '내 맘대로'));
  const s2 = S.listSessions().find((x) => x.id === id);
  assert.equal(s2.folder, '내 맘대로');
  assert.equal(s2.title, '내 맘대로');
  assert.ok(ls(id).includes('내 맘대로.mp4'));
});

test('설정을 끄면 고정 이름으로 돌아간다', () => {
  const id = fake({ title: '끄기' });
  S.applyNaming(id);
  saveConfig({ naming: { files: false } });
  S.applyNaming(id);
  assert.ok(ls(id).includes('recording.mp4') && ls(id).includes('transcript.md'));
  assert.equal(S.readSession(id).files, undefined);
});

test('녹화 중이면 미뤄 둔다', () => {
  saveConfig({ naming: { files: true } });
  const id = fake({ title: '녹화중' });
  S.updateSession(id, { status: 'recording' });
  const r = S.applyNaming(id);
  assert.equal(r.pending, true);
  assert.ok(ls(id).includes('recording.mp4'));
});
