# Pi Web UI Plan

## Goal

Build a **mobile-first web UI for `pi-coding-agent`** that can run locally on the Mac, be exposed remotely through **Cloudflare Tunnel + Cloudflare Access**, and reuse the existing local pi setup so the user can:

- keep using the normal pi CLI on the Mac
- open the web UI from a phone or browser
- see and continue existing pi sessions
- get **workflow parity** with pi CLI for the most important flows

This project is a **remote UI for pi**, not a separate chat app.

---

## Product requirements

### Must have

- Mobile-first UX
- Reuse existing `~/.pi/agent`
  - `auth.json`
  - `models.json`
  - `settings.json`
  - sessions directory
  - skills, prompts, extensions, AGENTS context
- Use `@mariozechner/pi-web-ui` as the UI library/foundation
- Support remote access behind Cloudflare Tunnel + Access
- Support pi workflow parity for common flows
- Support viewing and continuing sessions created in CLI
- Support sessions created in web being visible in CLI

### Parity target

Target **workflow parity**, not terminal/TUI parity.

This means matching the important capabilities and session behavior, not reproducing keyboard shortcuts or terminal-only layout.

### Concurrency requirement

The user wants to control the same session simultaneously.

Important implementation note:

- We can support **multiple web clients attached to the same backend-managed live session** reliably.
- We can support **best-effort interop** with stock pi CLI using the same session files.
- We cannot guarantee strong realtime collaborative behavior between a stock CLI process and the web backend when both mutate the same live session at once, because they are separate in-memory runtimes.

Therefore the v1 spec supports:

- **shared session continuity** between CLI and web
- **multi-web collaboration** on the same backend-managed session
- **best-effort simultaneous CLI + web access** with clear UI warnings when external changes are detected

---

## Architecture overview

## High-level design

Use a **local Node server** that embeds pi via the **`@mariozechner/pi-coding-agent` SDK** and serves a **browser UI** built with **`@mariozechner/pi-web-ui`**.

```text
Phone / Browser
    |
    | HTTPS via Cloudflare Tunnel + Access
    v
Local Pi Web Server (Node)
    |
    | pi SDK
    v
@mariozechner/pi-coding-agent
    |
    +-- ~/.pi/agent/auth.json
    +-- ~/.pi/agent/models.json
    +-- ~/.pi/agent/settings.json
    +-- ~/.pi/agent/sessions/
    +-- skills / prompts / extensions / AGENTS files
```

## Why SDK, not a standalone browser agent

`pi-coding-agent` needs local access to:

- filesystem
- bash
- session persistence
- extensions / skills / AGENTS discovery
- local auth and model config

That makes the browser the wrong place to run the real agent.

The browser should be a **thin, rich client** over a local server that owns the real pi runtime.

---

## Core design decisions

## 1. Backend owns the canonical live runtime

The server owns live `AgentSession` instances and exposes:

- command APIs
- session metadata APIs
- live event streams

For backend-managed live sessions, all connected web clients subscribe to the same canonical state.

## 2. Existing pi disk state is the source of truth

The app reuses `~/.pi/agent` by default.

That means:

- no duplicate auth store
- no duplicate models store
- no separate session persistence format
- web and CLI can both see the same session history

## 3. Web UI uses `@mariozechner/pi-web-ui` as a foundation, not as the entire app architecture

We will reuse from `@mariozechner/pi-web-ui` where it helps:

- styles / CSS
- attachment loading
- artifact rendering
- dialogs / common UI pieces
- message / tool rendering patterns where adaptable

We should **not** force the whole app around the stock `ChatPanel` if it does not map cleanly to pi session semantics.

## 4. Mobile-first first, desktop-friendly second

The primary layout is optimized for phone use. Desktop gets a wider responsive version of the same app.

## 5. Cloudflare Access is the primary auth boundary for remote use

The server assumes it is usually protected by Cloudflare Access when used remotely.

Still required in app:

- explicit trust model for forwarded headers
- configurable local-only mode
- warning banner if exposed without Access protection

---

## Non-goals for v1

- Reproducing the terminal TUI exactly
- Full keyboard shortcut parity
- Guaranteed safe simultaneous mutation of one live session by stock CLI and web backend
- Public internet exposure without an upstream access layer
- Full extension UI parity for arbitrary custom TUI components beyond what RPC/session APIs expose
- Native mobile app

---

## User experience specification

## Primary user stories

### Story 1: Continue from phone

1. User works in pi CLI on the Mac.
2. Later opens the web UI on a phone.
3. Sees the same session list.
4. Opens a recent session.
5. Continues working from the browser.

### Story 2: Start in web, resume in CLI

1. User creates a new session from phone.
2. Prompts the agent, runs tools, updates files.
3. Later goes to the Mac terminal.
4. Uses normal pi CLI and resumes the same session.

### Story 3: Observe and intervene during agent work

1. User starts a prompt from phone.
2. Sees streaming output and tool activity.
3. Sends a steering or follow-up message.
4. Aborts if needed.

### Story 4: Use project features from phone

1. User loads a session in a repo.
2. Pi still has access to AGENTS.md, skills, prompts, extensions, and configured models.
3. The web UI exposes relevant workflow controls.

---

## Mobile-first UI specification

## Main screen layout

### Header

Compact sticky header containing:

- session title
- session/source status
- model badge
- thinking level badge
- connection state
- stop button while streaming
- overflow menu

### Message timeline

Scroll area containing:

- user messages
- assistant messages
- tool call/result cards
- system notices
- extension interaction prompts
- artifacts/messages created during the run

### Composer

Sticky bottom composer containing:

- multi-line text input
- attach button
- camera/photo option on supported mobile browsers
- send button
- secondary actions for:
  - steer
  - follow-up
  - slash commands

## Mobile navigation surfaces

Use sheets/drawers instead of sidebars.

### Sessions sheet

- recent sessions list
- search/filter
- new session
- open session
- rename session
- fork session
- session stats preview

### Model sheet

- current model
- available models
- thinking level selector
- cycle model action

### Session actions sheet

- fork
- tree navigation
- compact
- export HTML
- copy last answer
- session stats

### Settings sheet

- steering mode
- follow-up mode
- auto compaction
- auto retry
- connection/debug info

### Tool detail view

Full-screen or large sheet for:

- bash output
- read file previews
- edit/write diffs or content
- long tool logs

## Desktop responsive behavior

On larger screens:

- main view remains conversation-first
- optional right-side detail panel may be added later for artifacts/tool details
- sessions/settings can remain drawers or become side panels

---

## Feature scope

## v1 workflow parity scope

### Conversation/runtime

- prompt
- steer
- follow-up
- abort
- streaming assistant text
- streaming tool execution
- display thinking when available
- show pending / busy / idle state

### Sessions

- list sessions
- open session
- new session
- rename session
- view recent sessions
- basic session stats
- fork session
- tree navigation

### Model/runtime controls

- get current model
- set model
- cycle model
- get available models
- get/set thinking level
- get/set steering mode
- get/set follow-up mode
- toggle auto compaction
- toggle auto retry
- manual compact

### Content/features

- attachments from browser
- image upload
- document upload if supported through pi-web-ui attachment helpers
- artifact display where produced
- slash command support via prompt entry
- available commands list

### Extension interaction parity

Map backend interaction events to web UI dialogs/sheets for:

- select
- confirm
- input
- editor
- notify
- status updates
- widgets/title updates when feasible

## Nice-to-have after v1

- better artifact workspace
- session diff/conflict inspector
- presence indicators across web clients
- push notifications for long-running completion
- install as PWA
- desktop split view

---

## Technical specification

## Workspace structure

```text
client/
  src/
    app/
    components/
    features/
    lib/
    styles/
  index.html
  vite.config.ts
  package.json

server/
  src/
    api/
    app/
    pi/
    sessions/
    transport/
    utils/
  package.json

shared/
  src/
    contracts/
    events/
    types/
  package.json

package.json
plan.md
```

## Package responsibilities

### `server`

- create/manage pi sessions
- read pi session metadata
- watch session files for external changes
- expose browser-friendly API
- authenticate/trust Cloudflare headers where configured
- serve static frontend in production

### `client`

- mobile-first UI
- session browsing and live conversation view
- command submission
- live event subscription
- attachment upload
- dialogs/sheets for extension interactions

### `shared`

- DTOs
- event contracts
- enums/types for session status, commands, etc.

---

## Backend specification

## Runtime model

The backend maintains a registry of live sessions.

### `LiveSession`

Suggested shape:

```ts
class LiveSession {
  id: string;
  sessionFile?: string;
  session: AgentSession;
  subscribers: Set<ClientConnection>;
  state: LiveSessionState;
  source: "backend-managed" | "loaded-from-disk";
  externallyDirty: boolean;
  lastExternalChangeAt?: string;
}
```

### Responsibilities

- create new live sessions
- attach clients to existing live sessions
- load sessions from disk into a live backend-managed runtime
- broadcast live events
- track busy/idle status
- detect when session file changes externally

## Session ownership model

### Backend-managed live session

A session currently loaded and controlled by the web server.

Properties:

- realtime events available
- multiple web clients can observe/control
- canonical web runtime exists in server memory

### Disk-only session

A session known from pi session files but not currently loaded into backend memory.

Properties:

- can be listed and opened
- no live stream until loaded
- may have been created or modified by CLI

### Externally changing session

A backend-managed or disk session whose session file changed outside the backend process.

Properties:

- UI should show a warning badge
- backend should refresh metadata/history snapshots
- if conflict risk is high, UI should warn that external concurrent edits are best-effort only

---

## Backend integration with pi

## SDK-first integration

Primary integration path:

- `createAgentSession()` from `@mariozechner/pi-coding-agent`
- `SessionManager` using the same cwd and session files
- default resource loading so skills/prompts/extensions/AGENTS remain available
- default auth/model/settings using `~/.pi/agent`

## Reused pi state

By default:

- `agentDir = ~/.pi/agent`
- default `AuthStorage.create()`
- default `ModelRegistry`
- default `SettingsManager`
- session manager pointed at project sessions as pi normally would

## Important compatibility rule

Do not create a parallel session format or a parallel auth/config store.

---

## Transport specification

## Recommendation

Use **WebSocket** for live session interaction.

Reasoning:

- bidirectional by design
- easier multi-client collaboration
- easier reconnect/resubscribe semantics
- cleaner fit for live dialogs/widgets/interactive prompts

Fallback option:

- SSE + HTTP commands is acceptable for the first spike if simpler
- but target architecture should still be websocket-friendly

## WebSocket responsibilities

- subscribe to session events
- push live updates
- send interaction responses
- publish presence/connection state later

## HTTP responsibilities

- bootstrap data
- list sessions
- fetch metadata/history snapshots
- create/open sessions
- upload attachments
- serve client assets

---

## API specification

## REST endpoints

### Health/config

- `GET /api/health`
- `GET /api/config`

### Sessions

- `GET /api/sessions`
  - list session metadata
- `POST /api/sessions`
  - create new live session
- `GET /api/sessions/:id`
  - get session details and current snapshot
- `POST /api/sessions/:id/open`
  - load disk session into backend-managed runtime
- `POST /api/sessions/:id/rename`
- `POST /api/sessions/:id/fork`
- `GET /api/sessions/:id/fork-messages`
- `POST /api/sessions/:id/tree/navigate`
- `GET /api/sessions/:id/stats`
- `POST /api/sessions/:id/export-html`

### Conversation/runtime

- `POST /api/sessions/:id/prompt`
- `POST /api/sessions/:id/steer`
- `POST /api/sessions/:id/follow-up`
- `POST /api/sessions/:id/abort`
- `POST /api/sessions/:id/compact`

### Models/settings/runtime controls

- `GET /api/models`
- `POST /api/sessions/:id/model`
- `POST /api/sessions/:id/model/cycle`
- `POST /api/sessions/:id/thinking-level`
- `POST /api/sessions/:id/steering-mode`
- `POST /api/sessions/:id/follow-up-mode`
- `POST /api/sessions/:id/auto-compaction`
- `POST /api/sessions/:id/auto-retry`

### Commands/resources

- `GET /api/sessions/:id/commands`
- `GET /api/sessions/:id/messages`

### Attachments

- `POST /api/attachments`
  - upload browser files/images for inclusion in prompts

## WebSocket channels/events

### Client -> server messages

- `subscribe_session`
- `unsubscribe_session`
- `prompt`
- `steer`
- `follow_up`
- `abort`
- `respond_select`
- `respond_confirm`
- `respond_input`
- `respond_editor`
- `ping`

### Server -> client events

- `session_snapshot`
- `session_state_changed`
- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `interaction_request`
- `interaction_cleared`
- `external_session_change_detected`
- `session_metadata_updated`
- `error`
- `pong`

---

## Data model specification

## Session list item

```ts
type SessionListItem = {
  id: string;
  sessionFile?: string;
  title: string;
  preview?: string;
  lastModified: string;
  messageCount: number;
  modelId?: string | null;
  thinkingLevel?: string;
  status: "idle" | "streaming" | "compacting" | "error";
  live: boolean;
  source: "backend-managed" | "disk";
  externallyDirty: boolean;
};
```

## Session snapshot

```ts
type SessionSnapshot = {
  id: string;
  sessionFile?: string;
  title: string;
  status: "idle" | "streaming" | "compacting" | "error";
  source: "backend-managed" | "disk";
  externallyDirty: boolean;
  model: ModelDto | null;
  thinkingLevel: "off" | "low" | "medium" | "high";
  steeringMode: "one-at-a-time" | "all";
  followUpMode: "one-at-a-time" | "all";
  autoCompactionEnabled: boolean;
  autoRetryEnabled: boolean;
  messages: UiMessage[];
  pendingInteraction?: PendingInteractionDto;
};
```

## UI message model

Keep this simple and close to pi event shapes.

```ts
type UiMessage =
  | UserUiMessage
  | AssistantUiMessage
  | ToolUiMessage
  | SystemUiMessage
  | ArtifactUiMessage;
```

The exact shape should be driven by what is needed for rendering, not by speculative abstraction.

---

## Session sync and concurrency specification

## v1 concurrency model

### Supported strongly

- multiple browser clients attached to one backend-managed live session
- sessions created in CLI visible in web
- sessions created in web visible in CLI
- continuing a session after switching devices

### Supported best-effort only

- stock pi CLI and web backend both mutating the same session around the same time

## External change detection

The backend should watch the pi session storage directory and detect:

- new session files
- modified session files
- deleted session files

Behavior:

- session list updates live
- open session views show an external-change badge when affected
- backend refreshes disk-derived metadata/history snapshots
- backend warns when current live state may have diverged from disk changes made elsewhere

## Conflict UX

If a backend-managed session changes externally:

- show banner: `Session changed outside web UI. History refreshed. Live collaboration with stock CLI is best-effort.`
- offer actions:
  - refresh snapshot
  - continue anyway
  - fork from latest visible point

---

## Frontend specification

## State management

Keep frontend state small and explicit.

Suggested top-level stores:

- `connectionStore`
- `sessionsStore`
- `activeSessionStore`
- `uiStore`
- `attachmentsStore`

No heavy framework-specific architecture unless needed.

## Screen/component breakdown

### App shell

- route handling
- auth/proxy banners
- websocket lifecycle

### Session list screen/sheet

- recent sessions
- search
- open/new/rename/fork

### Conversation screen

- header
- timeline
- composer
- inline state indicators

### Tool card components

- bash card
- read card
- edit/write card
- generic tool card

### Interaction components

- select dialog
- confirm dialog
- input dialog
- editor modal/sheet
- notification toast/banner

### Settings/model screens

- model picker
- thinking selector
- runtime toggles

### Tree/fork UI

- simple mobile list-based tree browser
- choose target message
- navigate/fork actions

---

## Use of `@mariozechner/pi-web-ui`

## Planned reuse

- `app.css`
- attachment loading helpers
- artifact display helpers/components if compatible
- common visual styles and patterns
- dialogs/tabs/selectors where practical

## Planned custom implementation

- session transport layer
- live state adapter for pi SDK events
- session list/history integration
- concurrency/external change handling
- mobile shell and navigation

## Acceptance rule

Use the library where it clearly reduces work and improves consistency. Do not force-fit abstractions that make pi session parity harder.

---

## Security specification

## Deployment assumptions

Primary deployment is:

- local server on Mac
- Cloudflare Tunnel exposes it
- Cloudflare Access protects it

## App-side security requirements

- default bind to `127.0.0.1`
- explicit opt-in to non-local bind
- configurable trusted proxy / forwarded header handling
- reject insecure origin assumptions by default
- clear startup warning if bound publicly without configured access layer

## Sensitive capabilities

This app indirectly exposes:

- filesystem access
- shell execution
- agent prompts and session history
- project content
- model credentials through pi runtime

Therefore, remote exposure without strong upstream access control is out of scope.

---

## Operational specification

## Local development

### Dev mode

- frontend Vite dev server
- backend dev server
- proxy frontend to backend

### Production/local runtime

- frontend built to static assets
- backend serves static assets and API/websocket from one port

## Port/config

Config via env or config file:

- `PORT`
- `HOST`
- `PI_AGENT_DIR` override optional
- `SESSION_WATCH_ENABLED`
- `TRUST_PROXY`
- `PUBLIC_BASE_URL`

---

## Milestone plan

## Milestone 1: technical spike

Goal: prove the critical integration path.

### Deliverables

- Node backend can create/open pi sessions with SDK
- live streaming events are exposed to browser
- browser can render one active session
- session list reads real pi sessions
- open a CLI-created session from the browser
- mobile shell is minimally usable

### Exit criteria

- user can open web UI on phone-sized viewport
- send prompt
- see streaming text and tool output
- list and open an existing pi session

## Milestone 2: usable remote MVP

### Deliverables

- new/open/rename session
- prompt/steer/follow-up/abort
- model + thinking controls
- websocket reconnect handling
- attachment upload
- session metadata/stats
- Cloudflare-friendly production serving

### Exit criteria

- realistic everyday remote usage works from phone

## Milestone 3: workflow parity expansion

### Deliverables

- tree navigation UI
- fork flow
- compact action
- auto compaction / retry controls
- available commands list
- extension interaction dialogs
- improved tool detail views

### Exit criteria

- common pi CLI workflows are available in browser

## Milestone 4: interop hardening

### Deliverables

- session file watching
- external change warnings
- better refresh/merge/fork affordances
- presence/multi-client polish

### Exit criteria

- shared CLI/web usage is understandable and safe enough for daily use

---

## Acceptance criteria

The project is successful when all of the following are true:

1. User can start the app locally on the Mac.
2. User can reach it from phone through Cloudflare Tunnel + Access.
3. The app reuses the existing `~/.pi/agent` state.
4. Sessions from CLI are visible in web.
5. Sessions from web are visible in CLI.
6. User can remotely perform core pi workflows from phone.
7. UI is mobile-first and comfortable on a narrow viewport.
8. Multiple web clients can attach to the same live session.
9. External session changes from CLI are surfaced clearly.
10. The implementation remains simple and maintainable.

---

## Open questions to resolve during implementation

1. Whether to use WebSocket immediately or start with SSE for the spike.
2. How much of `@mariozechner/pi-web-ui` tool/message rendering can be reused directly.
3. The best lightweight tree-navigation UI for mobile.
4. How to map arbitrary extension widget/status/title behavior into a clean mobile experience.
5. Whether to support optional backend-managed terminal presence indicators later.

---

## Recommended first implementation order

1. Scaffold workspace
2. Build backend session registry with one live session
3. Add browser event streaming
4. Render a single conversation screen
5. Add session list from pi session files
6. Add open/new session flows
7. Add model/thinking controls
8. Add attachment upload
9. Add external session file watching
10. Add parity workflows: fork, tree, compact, dialogs
