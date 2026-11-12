import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

export const PATH_EXTRA = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
export const ENV = { ...process.env, PATH: `${process.env.PATH || ''}:${PATH_EXTRA}` };

export function which(cmd) {
  for (const d of ENV.PATH.split(':')) {
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: ENV, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); err.stdout = String(stdout || ''); reject(err); }
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
export const runSync = (cmd, args, opts = {}) => execFileSync(cmd, args, { env: ENV, encoding: 'utf8', ...opts });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pad = (n) => String(n).padStart(2, '0');
export function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
export function hms(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
export function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// macOS 휴지통으로 보낸다(복구 가능). Finder 를 쓰면 «되돌려 놓기»도 된다.
export async function moveToTrash(p) {
  const esc = p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  try {
    await run('osascript', ['-e', `tell application "Finder" to delete (POSIX file "${esc}" as alias)`], { timeout: 15000 });
  } catch {
    const os = await import('node:os');
    const dst = path.join(os.homedir(), '.Trash', `${path.basename(p)}-${Date.now()}`);
    fs.renameSync(p, dst);
  }
}
