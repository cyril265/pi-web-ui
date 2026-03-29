Verdict
- The biggest bottleneck is cross-stack over-invalidation: the server emits full session snapshots for live events, and the client rerenders the whole app for each one.
- This will stay okay for short sessions, but it will degrade hard with long conversations, tool-heavy runs, or fast streaming updates.
- I profiled live interactions with browser traces and inspected both client and server paths. The most important files are client/src/main.ts, server/src/pi/live-session.ts, server/src/pi/serialize.ts, and server/src/index.ts.
Biggest Bottlenecks
- Full snapshot SSE on every live event The server calls publishSnapshot() for every session event in server/src/pi/live-session.ts:457, serializes the full snapshot in server/src/pi/serialize.ts:61, and writes the whole JSON event in server/src/index.ts:114. That means tool execution updates scale with total session size, not delta size.
- Whole app rerender on tiny changes The client root always rerenders via client/src/main.ts:2658. There are 76 renderApp() call sites, including SSE updates at client/src/main.ts:1023, sidebar search at client/src/main.ts:2888, composer typing at client/src/main.ts:2943, model search at client/src/main.ts:3362, and extension dialog typing at client/src/main.ts:3530.
- Conversation work scales with transcript length Every render rebuilds renderedMessages and the full conversation in client/src/main.ts:2840 and client/src/main.ts:2842, then walks all messages in client/src/main.ts:2778 and renders each message in client/src/main.ts:3079. There is no message virtualization.
- Message action context is O(n^2) getMessageActionContext() does findIndex, a backward scan, and slice(...).filter(...) in client/src/main.ts:1336 and client/src/main.ts:1352, and it is called per message in client/src/main.ts:2721.
- Markdown / tool parsing churn Ongoing renders repeatedly hit marked.parse in client/src/main.ts:2418, JSON parse/pretty-print in client/src/main.ts:1860 and client/src/main.ts:1861, syntax highlighting in client/src/main.ts:1788, and tool-arg parsing/sorting in client/src/main.ts:1953, client/src/main.ts:1958, and client/src/main.ts:1980.
- Streaming caches grow inside a session Caches only clear on session change in client/src/main.ts:890 and client/src/main.ts:948. But streaming assistant text is cached by full text in client/src/main.ts:2206 and client/src/main.ts:2417, so partial updates create lots of short-lived keys. codeBlockCopyCache also grows from client/src/main.ts:1775.
- Autoscroll forces layout on every event scrollToBottom() reads and writes layout in client/src/main.ts:1655, and it is called after every SSE event at client/src/main.ts:1024. That is expensive and also hostile to users reading older messages.
- Sidebar churn from synthetic timestamps getSnapshotLastModified() injects new Date().toISOString() in client/src/main.ts:908, then syncSessionListItem() resorts the full session list in client/src/main.ts:940. Live activity therefore causes extra list churn even when nothing meaningful changed for the sidebar.
Runtime Evidence
- I saved trace files at .tmp/ui-review/sidebar-search-profile.json and .tmp/ui-review/composer-typing-profile.json.
- Four quick sidebar-search edits produced 208 Document::UpdateStyleAndLayout events and 173 forced-layout update records.
- Four composer edits produced 189 Document::UpdateStyleAndLayout events and 144 forced-layout update records.
- Those are small interactions, so the trace matches the code smell: local input changes are invalidating much more UI than they should.
Server-Side Risk
- The highest long-session scalability risk is the snapshot model itself, not just the client render tree.
- server/src/pi/live-session.ts:422 updates tool execution state and then immediately publishes a full snapshot at server/src/pi/live-session.ts:457.
- server/src/pi/serialize.ts:67 reserializes all messages and server/src/pi/serialize.ts:85 re-sorts tool executions for each snapshot.
- So once real model streaming is enabled, you are paying network + JSON + render cost proportional to total session size on every incremental update.
What I Would Not Optimize First
- Initial-load bundle size is large, but you said it is not the priority. I agree it is secondary here.
- CSS animations like the streaming cursor in client/src/app.css:1339 and tool pulse in client/src/app.css:1442 are not the main problem.
- Small helpers like timeAgo() are noise compared to full snapshot transport and full-root rerendering.
Best Fix Order
1. [done] Replace raw renderApp() fan-out with a batched requestRender() and stop rerendering the whole tree for every keystroke/event.
2. [next] Change live updates from full snapshots to deltas for tool execution updates, title/status changes, and message append operations; keep full snapshots for open/reconnect only.
3. [done] Precompute message action context once per conversation render instead of per message.
4. [done] Only autoscroll when the user is already near the bottom.
5. Virtualize or window old messages; if that is too big, render the most recent chunk first.
6. Add memoized/LRU caches for structured tool rendering and use keyed list rendering for sessions/messages.
7. Remove new Date().toISOString() from snapshot-derived lastModified and keep sidebar ordering stable.
