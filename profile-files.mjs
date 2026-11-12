import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const profileName = /^[A-Za-z0-9_-]{1,80}$/;
const profileFilename = /^([A-Za-z0-9_-]{1,80})\.config\.toml$/;
const maxBytes = 256 * 1024;
export const profileRequestLimit = 6 * maxBytes + 1024;

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

export function listProfiles(codexHome) {
  try {
    return readdirSync(codexHome, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name.match(profileFilename)?.[1])
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    fail(500, '无法读取本机 Codex profile 列表。');
  }
}

function readProfileFile(path) {
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.nlink !== 1) fail(404, '未找到可编辑的 profile 文件。');
    const fd = openSync(path, 'r');
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== entry.ino || stat.dev !== entry.dev) {
        fail(409, 'profile 文件已变化，请重新读取。');
      }
      if (stat.size > maxBytes) fail(413, 'profile 文件超过 256 KB。');
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > maxBytes) fail(413, 'profile 文件超过 256 KB。');
      const bytes = buffer.subarray(0, length);
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (content.includes('\0')) fail(400, 'profile 文件必须是 UTF-8 文本。');
      return { content, revision: createHash('sha256').update(bytes).digest('hex'), mode: stat.mode & 0o777 };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'ENOENT') fail(404, '未找到可编辑的 profile 文件。');
    if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') fail(400, 'profile 文件必须是 UTF-8 文本。');
    fail(500, '无法读取 profile 文件。');
  }
}

function profilePath(codexHome, name) {
  if (!profileName.test(name)) fail(400, 'profile 名称无效。');
  return join(codexHome, `${name}.config.toml`);
}

export function getProfile(codexHome, name) {
  const { content, revision } = readProfileFile(profilePath(codexHome, name));
  return { content, revision };
}

export function saveProfile(codexHome, name, input) {
  const path = profilePath(codexHome, name);
  if (typeof input?.content !== 'string' || input.content.includes('\0') || typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision)) {
    fail(400, 'profile 内容或文件版本无效。');
  }
  const current = readProfileFile(path);
  if (current.revision !== input.revision) fail(409, 'profile 文件已被修改，请重新读取后再保存。');
  const content = /\r\n/.test(current.content) && !/(?<!\r)\n/.test(current.content)
    ? input.content.replace(/\r?\n/g, '\r\n')
    : input.content;
  if (Buffer.byteLength(content) > maxBytes) fail(413, 'profile 文件超过 256 KB。');
  if (content === current.content) return { content, revision: current.revision };
  const temp = join(codexHome, `.exo-profile-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, content, { flag: 'wx', mode: current.mode, flush: true });
    if (readProfileFile(path).revision !== current.revision) fail(409, 'profile 文件已被修改，请重新读取后再保存。');
    renameSync(temp, path);
  } catch (error) {
    if (error.status) throw error;
    fail(500, '无法保存 profile 文件，请检查文件权限。');
  } finally {
    try { rmSync(temp, { force: true }); } catch {}
  }
  return { content, revision: createHash('sha256').update(content).digest('hex') };
}
