# Progress

## Completed

### Planning
- Wrote the project spec to `plan.md`.
- Defined the initial architecture as:
  - Node backend using `@mariozechner/pi-coding-agent`
  - mobile-first Vite frontend
  - shared DTO/contracts package
  - reuse of existing `~/.pi/agent`

### Workspace setup
- Created a small npm workspace with:
  - `client/`
  - `server/`
  - `shared/`
- Added root scripts for:
  - `npm run dev`
  - `npm run build`
  - `npm run check`
  - `npm run start`
- Added base TypeScript config in `tsconfig.base.json`.

### Shared package
- Added `shared/src/index.ts` with shared API types for:
  - sessions
  - models
  - messages
  - tool executions
  - SSE events

### Server
- Added Fastify server in `server/src/index.ts`.
- Added API endpoints for:
  - health
  - sessions list
  - sessions list across all workspaces
  - create session
  - open session
  - get session snapshot
  - prompt
  - steer
  - follow-up
  - abort
  - cycle model
  - set model
  - set thinking level
  - rename session
  - list forkable prompts
  - fork session from a previous prompt
  - list tree-navigation prompts
  - navigate the current session tree
- Added SSE endpoint for live session updates.
- Configured static serving of the built client.
- Defaulted backend runtime workspace to the repository root instead of `server/`.

### Pi runtime integration
- Added `SessionRegistry` in `server/src/pi/session-registry.ts`.
- Wired it to:
  - `AuthStorage`
  - `ModelRegistry`
  - `createAgentSession()`
  - `SessionManager`
- Reused existing pi state from `~/.pi/agent` by default.
- Added session directory watching for basic external-change detection.
- Added recursive all-workspace session discovery from the shared pi sessions directory.
- When opening an existing session, now restore and use that session's original workspace cwd.
- Added session rename support through `SessionManager.appendSessionInfo()`.
- Added fork support through `AgentSession.fork()`.
- Added tree navigation support through `AgentSession.navigateTree()`.
- Added fork/tree prompt discovery from session history.

### Live session handling
- Added `LiveSession` in `server/src/pi/live-session.ts`.
- Tracks:
  - subscribers
  - tool execution state
  - snapshot publishing
  - external dirty flag

### Serialization
- Added `server/src/pi/serialize.ts`.
- Converts pi session/model/message/tool state into browser-friendly DTOs.
- Filtered noisy `thinking` content from assistant message rendering.

### Frontend
- Added Vite app shell with `client/index.html` and `client/vite.config.ts`.
- Added `client/src/main.ts` with a mobile-first UI that supports:
  - sessions sheet
  - model sheet
  - session actions sheet
  - message timeline
  - tool activity cards
  - sticky mobile composer
- Added prompt mode switching:
  - prompt
  - steer
  - follow-up
- Added stop button for abort.
- Added thinking level rotation button.
- Added image attachment upload support.
- Added session rename UI.
- Added session fork UI from earlier user prompts.
- Added in-session tree navigation UI from earlier user prompts.
- Added a hybrid session browser with current-workspace and all-workspaces views.
- Added session search and all-workspaces grouping by cwd.
- Added external-change warnings with reload-from-disk recovery.
- Improved message cards with clearer user/pi/tool presentation and timestamps.
- Improved tool activity rendering with expandable cards and clearer status badges.
- Improved assistant tool-call rendering to show concise tool call summaries instead of raw JSON blobs.
- Added extension UI bindings for confirm / input / select / editor dialogs in the web app.
- Added extension notifications, status entries, title updates, and widget rendering in the web app.
- Added extension-driven editor prefill support.
- Added `client/src/app.css` importing `@mariozechner/pi-web-ui/app.css`.
- Improved mobile UX with a clearer session header, touch-friendly action strip, segmented composer modes, stronger focus states, better loading skeletons, and explicit sheet close actions.
- Fixed mobile sheet behavior so overlays use a fixed body scroll lock with scroll restoration and the sheet wrapper owns scrolling.

### Docs
- Added `README.md` with:
  - dev commands
  - build/start commands
  - env vars
  - current scope

## Validation performed
- Installed dependencies with `npm install`.
- Fixed workspace/package issues.
- Fixed TypeScript issues until `npm run check` passed.
- Built the app successfully with `npm run build`.
- Started the server locally and verified:
  - `/api/health`
  - `/api/sessions`
  - `/`
- Created a session via API.
- Sent a real prompt through the backend and verified the session response.
- Removed temporary verification session files afterward.

## Additional fixes after first run
- Investigated the blank page in the browser.
- Verified the issue with `agent-browser` instead of relying only on logs.
- Found the runtime console error:
  - `Cannot access 'template' before initialization`
- Fixed it by moving `await bootstrap()` to the end of `client/src/main.ts` so rendering starts only after all top-level declarations exist.
- Re-verified the app with `agent-browser` on `http://localhost:5173/`.
- Confirmed the page renders visible UI controls and no page errors remain.

## Dev startup improvements
- Reworked `npm run dev` so it now auto-selects free ports instead of failing when defaults are occupied.
- Added `scripts/dev.mjs` to:
  - find a free backend port starting at `3001`
  - find a free client port starting at `5173`
  - start both processes with matching env vars
  - stop both processes together
- Updated `client/vite.config.ts` to read `CLIENT_PORT` and `API_PORT` from environment variables.
- Verified with `agent-browser` while `3001` and `5173` were intentionally occupied.
- Confirmed fallback startup on:
  - backend `3002`
  - frontend `5174`
- Confirmed the app still rendered correctly on the fallback frontend port.

## Validation additions for session workflows
- Verified the new session actions UI with `agent-browser`.
- Confirmed session rename updates the visible title in the browser.
- Confirmed session fork creates a new session and copies the selected prompt into the composer.
- Confirmed tree navigation rewinds the current session and copies the selected prompt into the composer.
- Confirmed the session sheet can switch between current-workspace and all-workspaces views.
- Confirmed session search works in the sheet.
- Confirmed the all-workspaces view groups sessions by workspace cwd.
- Confirmed sessions from other CLI workspaces appear in the all-workspaces view.
- Confirmed external session changes show a warning banner and can be reloaded from disk.
- Confirmed improved message/tool rendering in the browser with `agent-browser`.
- Confirmed assistant tool-call messages render as concise tool-call summaries.
- Confirmed extension dialog handling works in the browser using a temporary test extension command.
- Confirmed extension notifications, status entries, widgets, title updates, and editor prefill work in the browser.
- Confirmed the UX polish renders correctly in the browser, including the new header, composer, and session sheet controls.
- Re-ran `npm run check` after the workflow changes.

## Current state
The project now has a working MVP with:
- real pi backend integration
- mobile-first web UI
- live updates
- session create/open/list
- session rename
- session fork from earlier prompts
- in-session tree navigation from earlier prompts
- hybrid session browsing across current/all workspaces
- grouped/searchable all-workspaces session browser
- external-change warning and reload recovery
- improved message/tool rendering
- extension UI handling for confirm / input / select / editor / notify / status / widget / title / editor prefill
- prompting and basic runtime controls
- verified browser rendering and session workflows with `agent-browser`

## Not done yet
- richer tree navigation
- command list
- richer `pi-web-ui` component integration
- full extension parity for custom UI components and richer widgets
- websocket transport
- Cloudflare-specific hardening/config UX
- stronger simultaneous CLI/web collaboration handling
