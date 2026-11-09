// Remove only a recognized CLI transport envelope; leave stdout itself intact.
export function commandOutput(value) {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
  let offset = 0, hasStatus = false;
  for (let count = 0; count < 8; count++) {
    const rest = text.slice(offset);
    const match = rest.match(/^([^\r\n]*)(\r?\n|$)/);
    if (!match) break;
    const line = match[1];
    if (/^(?:Final output|Output):$/.test(line)) return hasStatus ? text.slice(offset + match[0].length) : text;
    if (/^(?:Process exited with code -?\d+|Exit code: -?\d+|Process running with session ID \d+)$/.test(line)) hasStatus = true;
    else if (!/^(?:Chunk ID: [\w.-]+|Wall time: [\d.]+ seconds|Original token count: \d+)$/.test(line)) break;
    if (!match[2]) break;
    offset += match[0].length;
  }
  return text;
}
