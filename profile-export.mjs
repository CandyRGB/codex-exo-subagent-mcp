import { join } from 'node:path';
import { managedConfig, tomlValue } from './model-config.mjs';

const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
const shQuote = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

export function exportProfile({ store, id, baseUrl, codexHome, moduleDir }) {
  const connection = store.get(id);
  if (!connection.enabled) throw Object.assign(new Error('请先启用此连接。'), { status: 400 });
  if (connection.kind === 'profile') throw Object.assign(new Error('此连接已经引用已有 profile，无需导出。'), { status: 400 });
  store.gatewayToken(); // Initialize the local credential file, never embed its contents.
  const name = `exo-${connection.id}`;
  const filename = `${name}.config.toml`;
  const config = {
    model: connection.default_model,
    ...managedConfig(connection, { baseUrl, fingerprint: store.fingerprint(connection) }),
  };
  const content = '# Codex CLI 0.134.0+ profile; manually save in CODEX_HOME.\n'
    + '# Requires the local Subagent gateway and SUBAGENT_GATEWAY_TOKEN.\n'
    + '# No API keys or gateway tokens are embedded. Re-export after route changes.\n'
    + Object.entries(config).map(([key, value]) => `${key} = ${tomlValue(value)}`).join('\n') + '\n';
  const port = new URL(baseUrl).port;
  const entry = join(moduleDir, 'open-viewer.mjs');
  const launch = process.platform === 'win32' ? [
    `$env:CODEX_HOME = ${psQuote(codexHome)}`,
    `$env:CODEX_SUBAGENT_STATE_DIR = ${psQuote(store.stateDir)}`,
    `$env:CODEX_SUBAGENT_VIEWER_PORT = ${psQuote(port)}`,
    `& ${psQuote(process.execPath)} ${psQuote(entry)} --no-open`,
    `if ($LASTEXITCODE -ne 0) { throw 'Subagent gateway failed to start' }`,
    `$env:SUBAGENT_GATEWAY_TOKEN = [IO.File]::ReadAllText(${psQuote(store.tokenPath)}).Trim()`,
    `codex --profile ${name}`,
  ].join('\n') : [
    `export CODEX_HOME=${shQuote(codexHome)}`,
    `export CODEX_SUBAGENT_STATE_DIR=${shQuote(store.stateDir)}`,
    `export CODEX_SUBAGENT_VIEWER_PORT=${shQuote(port)}`,
    `${shQuote(process.execPath)} ${shQuote(entry)} --no-open &&`,
    `SUBAGENT_GATEWAY_TOKEN="$(cat ${shQuote(store.tokenPath)})" codex --profile ${name}`,
  ].join('\n');
  return { filename, profile_name: name, target: join(codexHome, filename), content, launch,
    note: '将下载文件手动放到下方路径，再在终端运行启动命令（Codex CLI 0.134.0+）。无需 MCP，但仍需本机网关及此连接；关闭网页不影响网关。更改地址、协议或认证方式后需重新导出。手动 CLI 会话不进入本页面的 MCP 会话列表。已有同名文件时请先比较内容。' };
}
