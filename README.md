# Pi Web App

Mobile-first web UI for `pi-coding-agent`.

## Development

```bash
bun install
bun run dev
```

To expose the dev app on your local network temporarily for phone testing:

```bash
HOST=0.0.0.0 bun run dev
```

The dev runner automatically finds free ports.

Default starting points:

- web client: `http://127.0.0.1:5173`
- api server: `http://127.0.0.1:3001`

If those ports are already in use, `bun run dev` picks the next free ones and prints them.

## Production-style local run

```bash
bun run build
bun run start
```

Then open:

- http://127.0.0.1:3001

## Configuration

Optional environment variables:

- `HOST` - server bind host, default `127.0.0.1`
- `PORT` - server port, default `3001`
- `PI_AGENT_DIR` - override pi config dir, default `~/.pi/agent`
- `PI_WORKSPACE_DIR` - override workspace cwd used by the pi session runtime

## End-to-end smoke harness

The Playwright harness runs the built app against the real Fastify server with repo-local runtime fixtures:

```bash
bun run e2e:install
bun run e2e
```

`bun run e2e:prepare` materializes deterministic runtime data under `e2e/.runtime/` from tracked fixtures in `e2e/fixtures/`, then the Playwright `webServer` starts the real app with:

- `PI_AGENT_DIR=$REPO/e2e/.runtime/agent`
- `PI_WORKSPACE_DIR=$REPO/e2e/.runtime/workspace`
- `HOST=127.0.0.1`
- `PORT=3310`

## Current scope

Implemented today:

- real `pi-coding-agent` SDK backend
- reuse of existing `~/.pi/agent`
- session list / open / create
- hybrid session browser: current workspace or all workspaces
- grouped/searchable all-workspaces session browser
- session rename
- session fork from earlier user prompts
- in-session tree navigation from earlier user prompts
- session browsing across all `~/.pi/agent` workspaces
- external-change warnings with reload-from-disk recovery
- improved message and tool rendering
- per-message copy / retry / edit / fork actions with safe fork-based semantics
- UX polish for mobile interaction: clearer header, stronger focus states, sheet close buttons, and loading skeletons
- extension UI parity for confirm / input / select / editor / notify / status / widget / editor prefill / title
- live SSE updates
- prompt / steer / follow-up / abort
- model cycling and model picker
- thinking level rotation
- mobile-first chat layout with touch-friendly controls and segmented composer modes
- image attachments from browser

Not implemented yet:

- richer tree navigation parity (full tree view, summaries, labels)
- full extension parity for custom UI components and richer widget rendering
- collaborative conflict handling beyond basic external-change detection
- richer artifact UI
