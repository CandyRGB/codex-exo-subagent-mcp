# Repository Guidelines

## Project Structure

- `server.mjs` exposes the MCP tool over stdio. `runtime.mjs` starts Codex CLI jobs and manages their lifecycle.
- `viewer.mjs` serves the local workspace and model gateway. `history.mjs` loads registered MCP sessions, `model-store.mjs` manages connections, and `model-gateway.mjs` adapts upstream API requests.
- `web/` contains the browser JavaScript, HTML, CSS, and favicon. `tests/` contains test suites and fixtures. Consult [the reference](docs/REFERENCE.md) when changing tool actions, routing, or session visibility.

## Run and Test

Use Node.js 24 or newer. The project runs from source with no npm dependencies.

- `npm start` launches the MCP stdio server.
- `npm run viewer` opens the local workspace. `npm run settings` opens model settings.
- `npm test` runs the Node.js test suite.
- `npm run test:cli` exercises a real Codex CLI against a local fixture model service. `npm run test:live` calls the configured provider and may consume quota.

## Coding Style

Use ES modules, two-space indentation, and the surrounding file’s style. Use `.mjs` for Node modules, `.js` for browser modules, camelCase for JavaScript identifiers, and kebab-case for filenames and CSS classes. Preserve established API field names such as `connection_id`. The repository has no configured linter or formatter.

## Testing Guidelines

Use `node:test` and `node:assert/strict` in `tests/*.test.mjs`. Put lifecycle changes in `runtime.test.mjs`, transcript and viewer changes in `history.test.mjs`, and connection or gateway changes in `models.test.mjs`. Cover regressions with temporary state and local fixtures. Run a focused suite with `node --test tests/models.test.mjs`.

## Commits and Pull Requests

Use short, imperative commit subjects, such as `Hide the profile placeholder from dropdown options`. In pull requests, describe the behavior change, list the checks you ran, link any relevant issue, and include screenshots for visible UI changes.

## Local State and Credentials

Keep the viewer on loopback. Use a separate `CODEX_SUBAGENT_STATE_DIR` for experiments. Keep credentials, gateway tokens, and session data out of commits and screenshots.
