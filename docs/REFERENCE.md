# codex-exo-subagent v4 — configurable model workspace

Run independent Codex CLI agents through configured local models, API services, model routers or an existing Codex profile. The current `workbuddy` profile and `deepseek-v4.1-flash` model are retained as the initial connection. The default official Codex model and authentication configuration are not changed.

Requires Node.js 24+ and a Codex CLI supporting `exec --json` and `exec resume`. No npm packages are required. Keep all adjacent `.mjs` modules and the `web/` assets together.

## Local session page

Consecutive terminal commands are collapsed under a single command group; expanding it reveals compact per-command rows and edge-to-edge output. Disclosure state survives refresh. The Add connection action lives in the top bar and is shown only while model settings are open.

The conversation header shows only the model and status. Dates and turn/tool counts live in session information, and assistant messages display content without identity headers. The sidebar keeps branding, theme and refresh actions; connection errors appear when needed. Existing connections use a type label, while new connections expose the type selector.

Open `http://127.0.0.1:43187`. The page groups conversations by working directory under Projects and shows recent sessions as a title-only list, keeping update ordering without timestamps or date headings. Select a conversation to read user instructions, agent replies, commands and tool outputs. It supports search, automatic refresh, earlier-message loading, pinning, display-title changes and JSON export. Empty `write_stdin` polls from the same terminal process are folded into the original command card; calls that carry real input remain separate. Raw API records, exports and full outputs are preserved unchanged. Display metadata does not alter the original Codex logs.

## Model settings

Choose an effort scheme in the model dialog, then select a level or enter a custom value. The saved `effort_set` field restores the scheme in the editor. A `model_reasoning[model_id]` object overrides the connection defaults. Selecting the service default omits the effort field. Models without overrides inherit saved connection settings.

The gateway sends the selected value as `reasoning.effort` (Responses) or `reasoning_effort` (Chat). The editor can use levels declared by model discovery. Existing configurations may contain `thinking` or `reasoning` extension fields. Editing the scheme or level replaces those fields with a standard effort setting.

The gateway applies settings for each request's actual model and removes inherited CLI effort, including when the configured effort is blank. Raw effort values are not passed as CLI execution modes. Profile exports use the same gateway settings. Reconnect MCP once after upgrading to load the revised child startup logic.

Connection types are **Model API connection** and **Existing Codex profile**. API addresses, protocols, authentication and model IDs are entered manually. Existing profile names can be referenced without editing their files. Legacy `local` and `router` records retain their IDs and route fingerprints when edited in the new UI.

A saved API connection can export a Codex CLI 0.134.0+ `<name>.config.toml` file from the **More** menu; **Remove connection** is in the same menu. The preview includes the target path and terminal startup commands; it does not install or overwrite user files. The exported profile uses the same local gateway/provider definition as managed tasks. No upstream keys or local gateway tokens are embedded. The commands start the gateway and read its token from the local state directory. Keep that connection and gateway available, and re-export after endpoint/protocol/auth-mode changes. Manually launched CLI sessions are outside the MCP job registry and do not appear in this viewer.

Open `http://127.0.0.1:43187/#/settings/models`, or choose **模型与连接** in the sidebar. The settings header keeps only the add-connection entry; it no longer repeats the breadcrumb title or an English title, and the default-model banner is gone. Add a local deployment, direct API or router; select Responses API or OpenAI-compatible Chat Completions; enter the API base URL and authentication. Model IDs and the default model are managed in the editor's unified model list. Saved connections appear as compact, initially collapsed rows. The right-side disclosure opens one inline editor below its row; collapsing and reopening the current connection retains the draft. Add connection opens a new form at the top of the list. Each row shows the connection name, protocol, default model and status, with a set-default action and disclosure; model selection stays inside the editor. The service must expose the selected compatible API, and the model must support function/tool calling for agent work. Native Anthropic Messages and other protocols require a compatible external gateway.

Add or edit models in the model dialog. Optional API model limits are saved in `model_limits[model_id]`. The launcher passes the configured context window to Codex, and the gateway caps upstream output tokens at the configured maximum. Save the connection to persist dialog changes. The API Key check requests `/models` using the current connection draft. The model test uses the dialog draft, and the connection test uses saved settings. Both inference tests check stream completion and tool calling and can count toward provider usage. Profile models take their runtime settings from the referenced profile.

Saved keys use Windows DPAPI CurrentUser encryption in `state/config/credentials.json`. The connection list exposes a saved-key flag. The eye button requests the saved key from the local viewer on demand and clears the displayed value when the editor closes. Connections using an environment variable show its name in the editor. New connections use the API Key field on Windows and the environment variable field on other platforms. Saved custom authentication headers are retained.

Settings live in `state/config/models.json`. The MCP reloads them for each new task, so default-model changes do not require restarting an up-to-date MCP. Reconnect once after upgrading from v3 to load the new tool schema. Running tasks and resumed sessions keep their original connection. Changing a connection's endpoint/protocol/authentication mode makes an existing route fingerprint invalid; create a new task or restore the original route. Rotating a key for the same endpoint does not require changing the route.

Endpoint-backed tasks connect through the authenticated local HTTP model gateway. Responses requests are proxied as SSE; Chat Completions requests are translated locally, including message history, function/custom tools, streaming output and usage. The child CLI receives only a local gateway token; upstream API keys remain in the local service. The gateway is therefore needed while endpoint-backed tasks run. Closing the browser does not stop the gateway. Native-profile tasks keep using their configured provider directly.

The MCP starts the local viewer in a separate hidden Node process. The page remains available when a single MCP connection closes. After a system restart, the next MCP startup launches it again. You can also run `node open-viewer.mjs` to start it and open the default browser, or add `--no-open` to print the URL without opening a browser. Only loopback is supported.

The viewer displays only sessions explicitly linked to this MCP's bridge job registry. It does not import legacy sessions or discover conversations by provider/profile. Cached summaries and display metadata outside the registry are removed. Native logs are read only for registered session IDs. Both JSONL and Zstandard-compressed native logs are supported. System/developer context and encrypted reasoning records are omitted from the displayed transcript.

Native Codex logs are the primary source. New MCP tasks also save visible user/assistant/tool records as `history.jsonl`, so they can be viewed when the native rollout is unavailable. These local records are not sent back to the parent model. Sidebar indexing retains only summaries. Tool-output previews are capped at 64,000 characters, with a full-output download; JSON exports include complete outputs.

Viewer settings: `CODEX_SUBAGENT_VIEWER_PORT` (default `43187`), `CODEX_SUBAGENT_VIEWER_ENABLED=false` (disable automatic startup for that MCP), and `CODEX_HOME` (Codex session location). Viewer metadata and its summary cache live under `state/viewer/`. The current page is a history viewer; starting tasks and sending follow-up prompts continue through Codex/MCP.

## One MCP tool

`codex_subagent` accepts an `action`. Existing calls containing only `prompt`, `cwd`, `model`, `profile`, `sandbox`, and/or `timeout_sec` still run synchronously. Responses are now a compact JSON object inside the MCP text content, rather than an unbounded plain final message.

| Action | Required inputs | Behavior |
| --- | --- | --- |
| `run` (default) | `prompt` | Wait until the agent finishes. Prefer `start` for long tasks to avoid MCP request timeouts. |
| `start` | `prompt` | Start a background task and return its `job_id`. |
| `status` | `job_id` | Return state and progress without repeating the final reply. |
| `wait` | `job_id` | Wait up to `wait_sec` (default 25, maximum 30); return a bounded final reply if finished. A wait timeout does not cancel execution. |
| `cancel` | `job_id` | Stop the CLI process tree and report its actual terminal state. Does not undo edits the agent has already made. |
| `resume` | `job_id`, `prompt` | Start a new background turn in the recorded Codex session. Keeps the original model, profile, working directory and sandbox. Returns a new `job_id`. |
| `result` | `job_id` | Read a page of the saved final reply. Use `offset=next_offset` for the next page. |
| `list` | none | List recent tasks; `limit` defaults to 10 and has a maximum of 50. |
| `viewer` | none | Return the local history page URL. Task replies also include a direct session URL once the viewer has started. |
| `models` | none | List configured connection IDs and model IDs without credentials. Pass `connection_id` to inspect one connection's model list. |

Example requests:

```json
{"action":"start","cwd":"C:\\path\\to\\project","prompt":"Inspect the failing build and fix the cause. Run the relevant check and report the changed files.","sandbox":"workspace-write"}
{"action":"wait","job_id":"<returned job_id>","wait_sec":25}
{"action":"resume","job_id":"<completed job_id>","prompt":"Now verify the fix against the second input."}
{"action":"cancel","job_id":"<running job_id>"}
```

The child does not automatically receive the parent conversation. Provide file paths, task requirements and acceptance criteria. Use `resume` when the child needs its previous conversation, instead of copying a long transcript back through the main model. Concurrent turns on the same Codex session are blocked.

For `run` or `start`, omit `connection_id` and `model` to use website defaults, or select a connection returned by `models`. `model` can override that connection's raw model ID. The older explicit `profile` argument remains available and is mutually exclusive with `connection_id`.

## Context and usage

- A final reply/page is capped at 4,000 UTF-16 characters by default. Set `max_output_chars` from 256 to 16,000. This limits returned text, not model reasoning or files written by the agent.
- Full final replies remain in `state/jobs/<job_id>/result.txt`; the response includes the absolute path and pagination information.
- `status` includes event counts, the last event/item type and completed command/file-change/MCP-call counts when available. It does not forward internal reasoning or tool output.
- Usage is taken from Codex JSONL `turn.completed` events. Positive counts are returned as `usage.status="reported"`. Missing or all-zero usage is marked `unavailable`, never presented as free usage. No cost estimate is invented.
- The child's own `codex-subagent` MCP is disabled for that run to avoid recursive bridge startup. The parent MCP and other configuration remain intact.
- Prompts are sent to the CLI on stdin, rather than included in the operating-system command line.

## Defaults and storage

| Environment variable | Default |
| --- | --- |
| `CODEX_SUBAGENT_PROFILE` | `workbuddy` |
| `CODEX_SUBAGENT_MODEL` | `deepseek-v4.1-flash` |
| `CODEX_SUBAGENT_MAX_CONCURRENT` | `2` (per MCP process, maximum 16) |
| `CODEX_SUBAGENT_MAX_OUTPUT_CHARS` | `4000` |
| `CODEX_SUBAGENT_STATE_DIR` | `state` next to the entry point |
| `CODEX_SUBAGENT_CODEX_BIN` | Newest installed desktop Codex binary on Windows, otherwise `codex` on PATH |
| `CODEX_SUBAGENT_MAX_DEPTH` | `2` |

Execution timeout defaults to 900 seconds; `timeout_sec` accepts 1–86,400 seconds. Invalid working directories fail explicitly. Permissions are not escalated on errors.

Task records and final replies survive MCP restarts. Background execution is owned by the live MCP connection: normal disconnect/shutdown stops active tasks and records them as `interrupted`. This is not an independent daemon. A forced host/process crash may prevent normal child cleanup; stale records are marked interrupted when the owning PID is no longer alive. Resume a task when its `session_id` was successfully recorded. Session retention also depends on Codex's normal saved-session storage.

An active task owned by another live MCP connection can be queried, but must be cancelled from its originating chat. The bridge will not terminate processes solely on the basis of PIDs found in a saved record.

The MCP state stores task metadata, visible conversation/tool history and final replies; Codex also maintains its own normal session history. Results are retained until you remove the appropriate records; there is no automatic deletion.

## Activate or roll back

After updating the source files, reconnect this MCP server or restart Codex so it reloads the entry point and tool schema. Already running MCP processes keep their previously loaded code. Keep a copy of the previous source version if a rollback is needed, and back up runtime state separately; state and credentials are not tracked by this repository.

## Validation

From this source directory:

```powershell
node --test --test-timeout=30000 tests/runtime.test.mjs tests/history.test.mjs tests/models.test.mjs
```

The tests exercise real process creation and Windows process-tree termination with a local fixture. They cover asynchronous execution, bounded results, missing usage, persistence/resume, session locks, failures, timeout, concurrency, cancellation notifications and MCP disconnect cleanup without contacting a model provider.

An optional smoke test contacts your configured model twice, executes one read-only shell task, restarts the MCP process and verifies that the resumed conversation remembers a random nonce:

```powershell
node tests/smoke-real.mjs
```

`node tests/e2e-configured-cli.mjs` verifies the real installed Codex CLI against a deterministic local Chat Completions fixture, including an actual file write in an isolated test workspace, a shell command and session continuation. It does not contact a paid model provider.

Official CLI references: [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [CLI options](https://learn.chatgpt.com/docs/cli/reference).
