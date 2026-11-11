#!/usr/bin/env node
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { SessionRepository } from './history.mjs';
import { ModelStore, safeError } from './model-store.mjs';
import { ModelGateway, readJSON } from './model-gateway.mjs';
import { exportProfile } from './profile-export.mjs';

const root = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 43187;
export const stateIdentity = stateDir => createHash('sha256').update(resolve(stateDir).toLowerCase()).digest('hex').slice(0, 16);

export async function createViewer({ stateDir = join(root, 'state'), codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), port = DEFAULT_PORT, host = '127.0.0.1', modelStore = null } = {}) {
  if (host !== '127.0.0.1') throw new Error('The session viewer only binds to loopback');
  const repository = new SessionRepository({ stateDir, codexHome });
  let boundPort = port;
  const store = modelStore || new ModelStore({ stateDir });
  const gateway = new ModelGateway({ store, baseUrl: () => `http://${host}:${boundPort}` });
  const headers = {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
  };
  const server = http.createServer(async (request, response) => {
    const send = (code, value, type = 'application/json; charset=utf-8', extra = {}) => {
      response.writeHead(code, { ...headers, 'Content-Type': type, ...extra });
      response.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      const allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
      if (!allowedHosts.has(request.headers.host)) { send(403, { error: 'Invalid local host' }); return; }
      const origin = request.headers.origin;
      if (origin && ![`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`].includes(origin)) { send(403, { error: 'Cross-origin requests are not allowed' }); return; }
      const url = new URL(request.url, `http://127.0.0.1:${boundPort}`);
      if (request.method === 'GET' && url.pathname === '/health') {
        send(200, { service: 'codex-subagent-viewer', version: '4.0.0', state_id: stateIdentity(stateDir) }); return;
      }
      const inference = url.pathname.match(/^\/inference\/([A-Za-z0-9_-]+)\/v1\/responses$/);
      if (inference && request.method === 'POST') { await gateway.handle(request, response, inference[1]); return; }
      if (url.pathname === '/api/config' && request.method === 'GET') {
        send(200, { ...store.publicConfig(), codex_home: repository.codexHome });
        return;
      }
      if (request.method === 'GET' && ['/reasoning.js', '/api-endpoint.js'].includes(url.pathname)) {
        const moduleFile = url.pathname.slice(1, -3) + '.mjs';
        send(200, readFileSync(join(root, moduleFile)), 'text/javascript; charset=utf-8');
        return;
      }
      if (url.pathname === '/api/config/connections' && request.method === 'POST') { send(200, store.save(await readJSON(request))); return; }
      if (url.pathname === '/api/config/default' && request.method === 'PATCH') { const body = await readJSON(request); send(200, store.setDefault(body.connection_id, body.model)); return; }
      if (url.pathname === '/api/config/discover' && request.method === 'POST') { const body = await readJSON(request); send(200, await gateway.discover(body.connection, body.connection_id || null)); return; }
      const connectionRoute = url.pathname.match(/^\/api\/config\/connections\/([A-Za-z0-9_-]+)(\/(?:test|export-profile))?$/);
      if (connectionRoute) {
        const id = connectionRoute[1];
        if (request.method === 'PUT' && !connectionRoute[2]) { send(200, store.save(await readJSON(request), id)); return; }
        if (request.method === 'DELETE' && !connectionRoute[2]) { send(200, store.remove(id)); return; }
        if (request.method === 'POST' && connectionRoute[2] === '/export-profile') { send(200, exportProfile({ store, id, baseUrl: `http://${host}:${boundPort}`, codexHome, moduleDir: root })); return; }
        if (request.method === 'POST' && connectionRoute[2] === '/test') { const body = await readJSON(request); send(200, await gateway.probe(id, body.model)); return; }
      }
      if (request.method === 'GET' && url.pathname === '/api/sessions') {
        const sessions = await repository.list();
        send(200, { sessions, refreshed_at: new Date().toISOString() }); return;
      }
      const outputMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/entries\/(entry-\d+)\/output$/);
      if (outputMatch && request.method === 'GET') {
        const text = await repository.toolOutput(outputMatch[1], outputMatch[2]);
        send(200, text, 'text/plain; charset=utf-8', { 'Content-Disposition': `attachment; filename="tool-${outputMatch[2]}.txt"` }); return;
      }
      const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(\/export)?$/);
      if (match && request.method === 'GET') {
        const full = Boolean(match[2]);
        const data = await repository.get(decodeURIComponent(match[1]), {
          before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined,
          limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100, full,
        });
        const body = JSON.stringify(data);
        const etag = '"' + createHash('sha256').update(body).digest('hex').slice(0, 20) + '"';
        if (!full && request.headers['if-none-match'] === etag) { response.writeHead(304, headers); response.end(); return; }
        if (full) send(200, data, undefined, { 'Content-Disposition': `attachment; filename="deepseek-session-${data.session.id}.json"` });
        else send(200, data, undefined, { ETag: etag });
        return;
      }
      if (match && request.method === 'PATCH' && !match[2]) {
        if (!request.headers['content-type']?.startsWith('application/json')) { send(415, { error: 'Expected JSON' }); return; }
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 4096) { send(413, { error: 'Request too large' }); return; } }
        const result = await repository.update(decodeURIComponent(match[1]), JSON.parse(body));
        send(200, result); return;
      }
      const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/tool-output.js': ['tool-output.js', 'text/javascript; charset=utf-8'], '/settings.js': ['settings.js', 'text/javascript; charset=utf-8'], '/model-selection.js': ['model-selection.js', 'text/javascript; charset=utf-8'], '/dropdown.js': ['dropdown.js', 'text/javascript; charset=utf-8'], '/settings.css': ['settings.css', 'text/css; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (request.method === 'GET' && staticFiles[url.pathname]) {
        const [file, type] = staticFiles[url.pathname];
        send(200, readFileSync(join(root, 'web', file)), type); return;
      }
      send(404, { error: 'Not found' });
    } catch (error) { send(error.status || (error instanceof SyntaxError ? 400 : 500), { error: request.url.startsWith('/api/config') ? safeError(error.message) : error.status || error instanceof SyntaxError ? error.message : 'Unable to read the local session record' }); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, host, done); });
  boundPort = server.address().port;
  const url = `http://${host}:${boundPort}`;
  return { server, repository, store, gateway, url, close: () => new Promise((done, reject) => server.close(error => error ? reject(error) : done())) };
}

if (process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url) {
  const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
  const stateDir = resolve(arg('--state-dir') || process.env.CODEX_SUBAGENT_STATE_DIR || join(root, 'state'));
  const port = Number(arg('--port') || process.env.CODEX_SUBAGENT_VIEWER_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid viewer port');
  const viewer = await createViewer({ stateDir, port, codexHome: arg('--codex-home') || process.env.CODEX_HOME || join(homedir(), '.codex') });
  mkdirSync(join(stateDir, 'viewer'), { recursive: true });
  writeFileSync(join(stateDir, 'viewer', 'service.json'), JSON.stringify({ pid: process.pid, url: viewer.url, state_id: stateIdentity(stateDir), started_at: new Date().toISOString() }));
  console.log(`DeepSeek session viewer: ${viewer.url}`);
  process.once('SIGTERM', () => { void viewer.close(); });
  process.once('SIGINT', () => { void viewer.close(); });
}
