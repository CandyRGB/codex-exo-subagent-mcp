// Remove only a recognized CLI transport envelope; leave stdout itself intact.
export function commandTransport(value) {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
  let offset = 0, hasStatus = false, sessionId = null, exitCode = null;
  for (let count = 0; count < 8; count++) {
    const rest = text.slice(offset);
    const match = rest.match(/^([^\r\n]*)(\r?\n|$)/);
    if (!match) break;
    const line = match[1];
    if (/^(?:Final output|Output):$/.test(line)) return hasStatus ? { output: text.slice(offset + match[0].length), sessionId, exitCode } : { output: text, sessionId: null, exitCode: null };
    if (/^(?:Process exited with code -?\d+|Exit code: -?\d+|Process running with session ID \d+)$/.test(line)) {
      hasStatus = true;
      const running = line.match(/^Process running with session ID (\d+)$/);
      if (running) sessionId = running[1];
      else exitCode = Number(line.match(/(-?\d+)$/)[1]);
    }
    else if (!/^(?:Chunk ID: [\w.-]+|Wall time: [\d.]+ seconds|Original token count: \d+)$/.test(line)) break;
    if (!match[2]) break;
    offset += match[0].length;
  }
  return { output: text, sessionId: null, exitCode: null };
}

export const commandOutput = value => commandTransport(value).output;

// Presentation-only grouping; original entries, export and entry IDs remain intact.
export function coalesceTerminalEntries(entries) {
  const visible = [], processes = new Map();
  const part = entry => ({ id: entry.id, output: entry.output, output_truncated: entry.output_truncated });
  const update = (process, entry, parsed) => {
    const code = parsed.exitCode ?? entry.exit_code;
    if (code !== undefined && code !== null) {
      for (const anchor of process.anchors) { anchor.exit_code = code; anchor.status = code === 0 ? 'completed' : 'failed'; anchor.finished_at = entry.finished_at || entry.at; }
      processes.delete(process.id);
    }
  };
  for (const entry of entries) {
    if (entry.kind !== 'tool') { visible.push(entry); continue; }
    const parsed = commandTransport(entry.output);
    const stdin = /(?:^|\.)write_stdin$/.test(entry.name);
    const process = stdin ? processes.get(String(entry.arguments?.session_id)) : null;
    if (process && !entry.arguments?.chars) {
      process.anchor.display_output += parsed.output;
      process.anchor.output_parts.push(part(entry));
      process.anchor.output_truncated ||= Boolean(entry.output_truncated);
      update(process, entry, parsed); continue;
    }
    if (stdin && !entry.arguments?.chars && !parsed.output && entry.status !== 'failed' && (parsed.exitCode === null || parsed.exitCode === 0)) continue;
    const exec = /(?:^|\.)(?:exec_command|command_execution)$/.test(entry.name);
    if (process || (exec || stdin && !entry.arguments?.chars) && parsed.sessionId !== null) {
      const anchor = { ...entry, display_output: parsed.output, output_parts: [part(entry)], status: parsed.sessionId !== null || process ? 'running' : entry.status };
      if (process) { process.anchor = anchor; process.anchors.push(anchor); update(process, entry, parsed); }
      else processes.set(parsed.sessionId, { id: parsed.sessionId, anchor, anchors: [anchor] });
      visible.push(anchor);
    } else visible.push(entry);
  }
  return visible;
}

export async function completeCommandOutput(entry, readFull) {
  const chunks = [];
  for (const part of entry.output_parts || [entry]) chunks.push(commandOutput(part.output_truncated ? await readFull(part.id) : part.output));
  return chunks.join('');
}
