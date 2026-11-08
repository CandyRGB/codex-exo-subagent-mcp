import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const option = name => argv[argv.indexOf(name) + 1];
const input = readFileSync(0, 'utf8');
const spec = JSON.parse(input.split('\n\nTask:\n').at(-1));
const resumeIndex = argv.indexOf('resume');
const sessionId = resumeIndex < 0 ? randomUUID() : argv[resumeIndex + 1];
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
emit({ type: 'thread.started', thread_id: sessionId });
emit({ type: 'turn.started' });
if (spec.grandchildPath) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  writeFileSync(spec.grandchildPath, String(grandchild.pid));
}
emit({ type: 'item.started', item: { id: '1', type: 'command_execution', command: 'secret command', aggregated_output: 'PRIVATE_TOOL_OUTPUT', status: 'in_progress' } });
if (spec.oversized) process.stdout.write('x'.repeat(2_100_000) + '\n');
if (spec.delay) await new Promise(done => setTimeout(done, spec.delay));
if (spec.fail) {
  emit({ type: 'turn.failed', error: { message: spec.error || 'fixture failure' } });
  process.exit(spec.exitZero ? 0 : 7);
}
emit({ type: 'item.completed', item: { id: '1', type: 'command_execution', aggregated_output: 'PRIVATE_TOOL_OUTPUT', status: 'completed' } });
const text = spec.reportArgs ? JSON.stringify({ argv, input, depth: process.env.CODEX_SUBAGENT_DEPTH }) : spec.text || 'FAKE_OK';
writeFileSync(option('--output-last-message'), text, 'utf8');
emit({ type: 'item.completed', item: { id: '2', type: 'agent_message', text } });
emit({ type: 'turn.completed', usage: spec.zeroUsage ? { input_tokens: 0, output_tokens: 0 } : { input_tokens: 101, cached_input_tokens: 20, output_tokens: 12, reasoning_output_tokens: 3 } });
