// 확장 전체에서 쓰는 설정·서버 호출
export const DEFAULT_PORT = 7931;

export async function getSettings() {
  const s = await chrome.storage.local.get({ port: DEFAULT_PORT, mic: true, micId: '' });
  return { ...s, server: `http://127.0.0.1:${s.port}` };
}

/** 서버가 살아 있으면 {ok, version}, 아니면 null */
export async function health(server, timeoutMs = 1500) {
  try {
    const r = await fetch(`${server}/health`, { headers: { 'X-Macrec': '1' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** JSON API 호출. 실패하면 Error(status 포함) */
export async function apiJSON(server, path, body) {
  const r = await fetch(`${server}${path}`, {
    method: 'POST',
    headers: { 'X-Macrec': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(j.error || `서버 오류 ${r.status}`); e.status = r.status; throw e; }
  return j;
}
