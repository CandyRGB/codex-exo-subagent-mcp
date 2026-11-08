import { JobManager } from '../runtime.mjs';
import { startServer } from '../server.mjs';
import { fileURLToPath } from 'node:url';
startServer({ manager: new JobManager({
  codexBin: process.execPath,
  codexArgs: [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url))],
  stateDir: process.env.TEST_STATE_DIR,
}) });
