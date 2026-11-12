import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { DEFAULT_PORT, stateIdentity } from './viewer.mjs';

const wait = ms => new Promise(done => setTimeout(done, ms));
const normalizedPath = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);

export function appVersion(moduleDir) {
  try { return JSON.parse(readFileSync(join(moduleDir, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

export function viewerMatches(health, expected) {
  if (!health || health.service !== 'codex-subagent-viewer') return false;
  return health.version === expected.version
    && typeof health.codex_home === 'string' && health.codex_home.length > 0
    && normalizedPath(health.codex_home) === normalizedPath(expected.codexHome);
}

function recordedPid(stateDir, stateId) {
  try {
    const data = JSON.parse(readFileSync(join(stateDir, 'viewer', 'service.json'), 'utf8'));
    return data.state_id === stateId && Number.isInteger(data.pid) && data.pid > 0 ? data.pid : null;
  } catch { return null; }
}

async function stopStale({ stateDir, stateId, health, probe }) {
  const pid = Number.isInteger(health.pid) && health.pid > 0 ? health.pid : recordedPid(stateDir, stateId);
  if (!pid || pid === process.pid) throw new Error('本机工作区由旧版本启动且无法确认其进程，请手动结束占用该端口的 Node 进程后重试。');
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw new Error(`无法停止旧版本的本机工作区（PID ${pid}）：${error.message}`); }
  for (let attempt = 0; attempt < 50; attempt++) {
    await wait(100);
    if (!(await probe())) return;
  }
  throw new Error(`旧版本的本机工作区（PID ${pid}）没有退出，请手动结束后重试。`);
}

export async function ensureViewer({ stateDir, moduleDir = dirname(fileURLToPath(import.meta.url)), port = Number(process.env.CODEX_SUBAGENT_VIEWER_PORT || DEFAULT_PORT), codexHome = process.env.CODEX_HOME || join(homedir(), '.codex') } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('工作区端口无效。');
  const url = `http://127.0.0.1:${port}`;
  const stateId = stateIdentity(stateDir);
  const expected = { version: appVersion(moduleDir), codexHome: resolve(codexHome) };
  const probe = async () => {
    let response;
    try { response = await fetch(url + '/health', { signal: AbortSignal.timeout(700) }); }
    catch { return null; }
    if (!response.ok) throw new Error(`端口 ${port} 已被其他服务占用（HTTP ${response.status}）。`);
    let health;
    try { health = await response.json(); }
    catch { throw new Error(`端口 ${port} 已被其他服务占用。`); }
    if (health.service !== 'codex-subagent-viewer') throw new Error(`端口 ${port} 已被其他服务占用。`);
    if (health.state_id !== stateId) throw new Error(`端口 ${port} 属于另一个状态目录的本机工作区，请为当前实例指定其他端口。`);
    return health;
  };
  const health = await probe();
  if (health && viewerMatches(health, expected)) return url;
  if (health) await stopStale({ stateDir, stateId, health, probe });
  mkdirSync(join(stateDir, 'viewer'), { recursive: true });
  const log = openSync(join(stateDir, 'viewer', 'service.log'), 'a');
  try {
    const child = spawn(process.execPath, [join(moduleDir, 'viewer.mjs'), '--state-dir', stateDir, '--port', String(port), '--codex-home', codexHome], {
      detached: true, windowsHide: true, stdio: ['ignore', log, log],
    });
    child.on('error', () => {});
    child.unref();
  } finally { closeSync(log); }
  for (let attempt = 0; attempt < 25; attempt++) {
    await wait(120);
    if (viewerMatches(await probe(), expected)) return url;
  }
  throw new Error(`本机工作区未能启动，请查看 ${join(stateDir, 'viewer', 'service.log')}。`);
}
