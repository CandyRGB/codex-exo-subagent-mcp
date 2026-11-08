import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ensureViewer } from './viewer-client.mjs';
const root = dirname(fileURLToPath(import.meta.url));
const url = await ensureViewer({ stateDir: process.env.CODEX_SUBAGENT_STATE_DIR || join(root, 'state') });
const target = process.argv.includes('--settings') ? `${url}/#/settings/models` : url;
console.log(target);
if (!process.argv.includes('--no-open')) {
  const command = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  command[1][command[1].length - 1] = target;
  const browser = spawn(command[0], command[1], { detached: true, windowsHide: true, stdio: 'ignore' });
  browser.on('error', error => console.error(error.message));
  browser.unref();
}
