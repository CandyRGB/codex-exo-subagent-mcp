import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelStore } from '../model-store.mjs';
import { JobManager, resolveCodexBinary } from '../runtime.mjs';
import { createViewer } from '../viewer.mjs';
import { readJSON } from '../model-gateway.mjs';

const root = fileURLToPath(new URL(`../.test-runs/configured-cli-${randomUUID()}/`, import.meta.url));
mkdirSync(join(root, 'workspace'), { recursive: true });
const requests = [];
let fileToolKind = null;
const upstream = http.createServer(async (request, response) => {
  try {
    const body = await readJSON(request, 64_000_000); requests.push(body);
    const hasToolOutput = body.messages.some(m => m.role === 'tool' && String(m.content).includes('SUBAGENT_CONFIG_SHELL_OK'));
    const lastUser = body.messages.filter(m => m.role === 'user').at(-1);
    const resume = JSON.stringify(lastUser).includes('CONFIG_RESUME_CHECK');
    let delta, reason;
    if (resume) { assert.ok(hasToolOutput, 'resume retains the earlier tool result'); delta = { content: 'CONFIG_RESUME_OK' }; reason = 'stop'; }
    else if (hasToolOutput) { delta = { content: 'CONFIG_CLI_OK' }; reason = 'stop'; }
    else if (!existsSync(join(root, 'workspace', 'config-fixture.txt'))) {
      const tool = body.tools.find(t => /apply_patch/.test(t.function.name));
      const patch = '*** Begin Patch\n*** Add File: config-fixture.txt\n+CONFIG_PATCH_OK\n*** End Patch';
      if (tool) {
        fileToolKind = 'apply_patch';
        const key = tool.function.parameters?.properties?.patch ? 'patch' : 'input';
        delta = { tool_calls: [{ index: 0, id: 'call_e2e_patch', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ [key]: patch }) } }] };
      } else {
        fileToolKind = 'exec_command';
        const shell = body.tools.find(t => /exec_command/.test(t.function.name)); assert.ok(shell, 'The client provides a file-capable command tool');
        delta = { tool_calls: [{ index: 0, id: 'call_e2e_write', type: 'function', function: { name: shell.function.name, arguments: JSON.stringify({ cmd: "[System.IO.File]::WriteAllText('config-fixture.txt', 'CONFIG_PATCH_OK')" }) } }] };
      }
      reason = 'tool_calls';
    } else {
      const tool = body.tools.find(t => /exec_command/.test(t.function.name));
      assert.ok(tool, 'Codex exposes a command tool; available tools: ' + body.tools.map(t => t.function.name).join(', '));
      delta = { tool_calls: [{ index: 0, id: 'call_e2e_shell', type: 'function', function: { name: tool.function.name, arguments: JSON.stringify({ cmd: 'Write-Output SUBAGENT_CONFIG_SHELL_OK' }) } }] }; reason = 'tool_calls';
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }], usage: { prompt_tokens: 25, completion_tokens: 12, total_tokens: 37 } }) + '\n\ndata: [DONE]\n\n');
  } catch (error) { console.error(JSON.stringify({ fixture_error: error.message })); response.writeHead(500); response.end(error.message); }
});
await new Promise(done => upstream.listen(0, '127.0.0.1', done));
const store = new ModelStore({ stateDir: join(root, 'state') });
const config = store.save({ name: 'Local fixture connection', kind: 'local', protocol: 'chat_completions', base_url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_mode: 'none', models: ['local-fixture-model'], default_model: 'local-fixture-model', context_window: 128000 });
const initialConnection = config.connections.at(-1);
const updated = store.save({ ...initialConnection, reasoning_effort: 'fixture-default', model_reasoning: { 'local-fixture-model': { reasoning_effort: 'fixture-custom' } } }, initialConnection.id);
const connection = updated.connections.at(-1); store.setDefault(connection.id, connection.default_model);
const viewer = await createViewer({ stateDir: store.stateDir, port: 0, modelStore: store });
const manager = new JobManager({ stateDir: store.stateDir, modelStore: store, codexBin: resolveCodexBinary(), env: { ...process.env, CODEX_SUBAGENT_VIEWER_PORT: String(viewer.server.address().port), CODEX_SUBAGENT_DEPTH: '0' } });
async function finish(id) { let result; do { result = await manager.wait(id, 25); console.log(JSON.stringify({ job: id, status: result.status, event: result.progress.last_event })); } while (['running', 'cancelling'].includes(result.status)); assert.equal(result.status, 'completed', JSON.stringify(result)); return result; }
try {
  console.log(JSON.stringify({ stage: 'real_codex_cli_with_local_chat_fixture', root }));
  const started = await manager.call({ action: 'start', cwd: join(root, 'workspace'), sandbox: 'workspace-write', timeout_sec: 120, prompt: '这是本地协议适配测试。请在当前测试目录写入 config-fixture.txt，内容 CONFIG_PATCH_OK，然后通过 shell 输出 SUBAGENT_CONFIG_SHELL_OK。所有文件改动仅限当前测试目录。' });
  const first = await finish(started.job_id); assert.equal(first.result.text.trim(), 'CONFIG_CLI_OK'); assert.equal(first.connection_id, connection.id);
  const resumed = await manager.call({ action: 'resume', job_id: first.job_id, timeout_sec: 120, prompt: 'CONFIG_RESUME_CHECK：请保留前一轮工具执行的上下文，只回复 CONFIG_RESUME_OK。' });
  const second = await finish(resumed.job_id); assert.equal(second.result.text.trim(), 'CONFIG_RESUME_OK'); assert.equal(second.session_id, first.session_id);
  assert.ok(first.progress.completed_commands >= 1);
  assert.equal(readFileSync(join(root, 'workspace', 'config-fixture.txt'), 'utf8').trim(), 'CONFIG_PATCH_OK');
  const exported = await (await fetch(`${viewer.url}/api/config/connections/${connection.id}/export-profile`, { method: 'POST' })).json();
  const profileHome = join(root, 'profile-home'); mkdirSync(profileHome);
  writeFileSync(join(profileHome, exported.filename), exported.content);
  const profileResult = join(root, 'profile-result.txt');
  await new Promise((done, reject) => {
    const child = spawn(resolveCodexBinary(), ['exec', '--profile', exported.profile_name, '--cd', join(root, 'workspace'), '--sandbox', 'workspace-write', '--skip-git-repo-check', '--json', '--output-last-message', profileResult, '-'], {
      env: { ...process.env, CODEX_HOME: profileHome, SUBAGENT_GATEWAY_TOKEN: store.gatewayToken() }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Exported profile CLI timed out')); }, 90000);
    child.stdout.on('data', data => { output = (output + data).slice(-16000); }); child.stderr.on('data', data => { output = (output + data).slice(-16000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? done() : reject(new Error(`Exported profile CLI exit ${code}: ${output}`)); });
    child.stdin.end('PROFILE_EXPORT_CHECK：通过 shell 输出 SUBAGENT_CONFIG_SHELL_OK，然后结束。');
  });
  assert.equal(readFileSync(profileResult, 'utf8').trim(), 'CONFIG_CLI_OK');
  assert.ok(requests.length > 0 && requests.every(request => request.reasoning_effort === 'fixture-custom'), 'Every CLI, resume and exported profile request applies the selected model effort');
  const report = { passed: true, real_codex_cli: true, model_backend: 'deterministic_local_chat_completions_fixture', configured_connection_used: true, exported_profile_used: true, custom_model_effort_used: true, actual_shell_executed: true, actual_file_created: true, file_tool_kind: fileToolKind, resume_retains_tool_history: true, usage: first.usage, upstream_requests: requests.length, tested_at: new Date().toISOString() };
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  if (process.argv[2]) writeFileSync(resolve(process.argv[2]), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await manager.shutdown(); await viewer.close(); await new Promise(done => { upstream.closeAllConnections(); upstream.close(done); }); }
