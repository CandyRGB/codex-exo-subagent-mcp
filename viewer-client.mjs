import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { DEFAULT_PORT, stateIdentity } from './viewer.mjs';

export async function ensureViewer({ stateDir, moduleDir = dirname(fileURLToPath(import.meta.url)), port = Number(process.env.CODEX_SUBAGENT_VIEWER_PORT || DEFAULT_PORT), codexHome = process.env.CODEX_HOME || join(homedir(), '.codex') }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid viewer port');
  const url = `http://127.0.0.1:${port}`;
  const expected = stateIdentity(stateDir);
  const check = async () => {
    try {
      const response = await fetch(url + '/health', { signal: AbortSignal.timeout(700) });
      const data = await response.json();
      if (data.service !== 'codex-subagent-viewer' || data.state_id !== expected) throw new Error('The viewer port belongs to a different service or state directory');
      return true;
    } catch (error) { if (/different service/.test(error.message)) throw error; return false; }
  };
  if (await check()) return url;
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
    await new Promise(done => setTimeout(done, 120));
    if (await check()) return url;
  }
  throw new Error(`The local session viewer did not start. Inspect ${join(stateDir, 'viewer', 'service.log')}`);
}
