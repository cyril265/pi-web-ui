import { cpSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = resolve(rootDir, "e2e/fixtures");
const runtimeDir = resolve(rootDir, "e2e/.runtime");
const agentFixturesDir = resolve(fixturesDir, "agent");
const workspaceFixturesDir = resolve(fixturesDir, "workspace");
const agentDir = resolve(runtimeDir, "agent");
const workspaceDir = resolve(runtimeDir, "workspace");
const sessionsDir = resolve(agentDir, "sessions");

rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(workspaceDir, { recursive: true });

cpSync(workspaceFixturesDir, workspaceDir, { recursive: true });
cpSync(resolve(agentFixturesDir, "auth.json"), resolve(agentDir, "auth.json"));
cpSync(resolve(agentFixturesDir, "models.json"), resolve(agentDir, "models.json"));

for (const fixture of createFixtureSessions(workspaceDir)) {
  const filePath = resolve(sessionsDir, fixture.fileName);
  const modifiedAt = new Date(fixture.modifiedAt);
  writeFileSync(filePath, fixture.contents);
  utimesSync(filePath, modifiedAt, modifiedAt);
}

console.log(`[e2e] prepared runtime fixtures in ${runtimeDir}`);
console.log(`[e2e] PI_AGENT_DIR=${agentDir}`);
console.log(`[e2e] PI_WORKSPACE_DIR=${workspaceDir}`);

function createFixtureSessions(workspacePath: string) {
  return [
    {
      fileName: "fixture-smoke-session.jsonl",
      modifiedAt: "2024-03-03T00:00:00.000Z",
      contents: createSessionFile({
        id: "fixture-smoke-session",
        cwd: workspacePath,
        timestamp: "2024-03-03T00:00:00.000Z",
        entries: [
          createMessageEntry({
            entryId: "fixture-user-entry",
            messageId: "fixture-user-message",
            parentId: null,
            at: "2024-03-03T00:00:01.000Z",
            role: "user",
            content: "Playwright harness smoke fixture",
          }),
          createMessageEntry({
            entryId: "fixture-assistant-entry",
            messageId: "fixture-assistant-message",
            parentId: "fixture-user-entry",
            at: "2024-03-03T00:00:02.000Z",
            role: "assistant",
            stopReason: "endTurn",
            content: [
              {
                type: "thinking",
                thinking: [
                  "Inspecting the fixture session.",
                  "Preparing markdown, diff, and tool activity examples for the UI.",
                ].join("\n"),
              },
              {
                type: "text",
                text: [
                  "Fixture session ready for Playwright.",
                  "",
                  "```ts",
                  "export function greet(name: string) {",
                  "  return `hi ${name}`;",
                  "}",
                  "```",
                  "",
                  "| Area | Status |",
                  "| --- | --- |",
                  "| Sessions | Loaded |",
                  "| Markdown | Rendered |",
                  "",
                  "```diff",
                  "diff --git a/client/src/main.ts b/client/src/main.ts",
                  "@@ -1,2 +1,3 @@",
                  '-const mode = "default";',
                  '+const mode = "dense";',
                  "+console.log(mode);",
                  "```",
                ].join("\n"),
              },
            ],
          }),
          createMessageEntry({
            entryId: "follow-up-user-entry",
            messageId: "follow-up-user-message",
            parentId: "fixture-assistant-entry",
            at: "2024-03-03T00:00:03.000Z",
            role: "user",
            content: "Follow-up prompt for edit and fork flows",
          }),
          createMessageEntry({
            entryId: "tool-activity-assistant-entry",
            messageId: "tool-activity-assistant-message",
            parentId: "follow-up-user-entry",
            at: "2024-03-03T00:00:04.000Z",
            role: "assistant",
            stopReason: "toolUse",
            content: [
              {
                type: "text",
                text: "This response includes grouped tool activity for the E2E harness.",
              },
              {
                type: "toolCall",
                id: "tool-call-bash",
                name: "bash",
                arguments: {
                  command: "ls -1 client/src",
                },
              },
              {
                type: "toolCall",
                id: "tool-call-read-file",
                name: "read_file",
                arguments: {
                  path: "client/src/main.ts",
                },
              },
              {
                type: "toolCall",
                id: "tool-call-read-success",
                name: "read",
                arguments: {
                  path: "shared/src/index.ts",
                },
              },
            ],
          }),
          createMessageEntry({
            entryId: "tool-result-success-entry",
            messageId: "tool-result-success-message",
            parentId: "tool-activity-assistant-entry",
            at: "2024-03-03T00:00:05.000Z",
            role: "toolResult",
            toolCallId: "tool-call-bash",
            toolName: "bash",
            isError: false,
            content: [
              {
                type: "text",
                text: "app.css\nmain.ts",
              },
            ],
          }),
          createMessageEntry({
            entryId: "tool-result-error-entry",
            messageId: "tool-result-error-message",
            parentId: "tool-result-success-entry",
            at: "2024-03-03T00:00:06.000Z",
            role: "toolResult",
            toolCallId: "tool-call-read-file",
            toolName: "read_file",
            isError: true,
            content: [
              {
                type: "text",
                text: "Error: permission denied while reading client/src/main.ts",
              },
            ],
          }),
          createMessageEntry({
            entryId: "tool-result-read-success-entry",
            messageId: "tool-result-read-success-message",
            parentId: "tool-result-error-entry",
            at: "2024-03-03T00:00:07.000Z",
            role: "toolResult",
            toolCallId: "tool-call-read-success",
            toolName: "read",
            isError: false,
            content: [
              {
                type: "text",
                text: [
                  'export type SessionStatus = "idle" | "streaming" | "error";',
                  "",
                  'export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | string;',
                  "",
                  "export interface ApiModelInfo {",
                  "  provider: string;",
                  "}",
                ].join("\n"),
              },
            ],
          }),
        ],
      }),
    },
    {
      fileName: "fixture-secondary-session.jsonl",
      modifiedAt: "2024-03-02T00:00:00.000Z",
      contents: createSessionFile({
        id: "fixture-secondary-session",
        cwd: workspacePath,
        timestamp: "2024-03-02T00:00:00.000Z",
        entries: [
          createMessageEntry({
            entryId: "secondary-user-entry",
            messageId: "secondary-user-message",
            parentId: null,
            at: "2024-03-02T00:00:01.000Z",
            role: "user",
            content: "Secondary session switch target",
          }),
          createMessageEntry({
            entryId: "secondary-assistant-entry",
            messageId: "secondary-assistant-message",
            parentId: "secondary-user-entry",
            at: "2024-03-02T00:00:02.000Z",
            role: "assistant",
            stopReason: "endTurn",
            content: "Secondary session opened from the sidebar.",
          }),
        ],
      }),
    },
    {
      fileName: "fixture-archive-session.jsonl",
      modifiedAt: "2024-03-01T00:00:00.000Z",
      contents: createSessionFile({
        id: "fixture-archive-session",
        cwd: workspacePath,
        timestamp: "2024-03-01T00:00:00.000Z",
        entries: [
          createMessageEntry({
            entryId: "archive-user-entry",
            messageId: "archive-user-message",
            parentId: null,
            at: "2024-03-01T00:00:01.000Z",
            role: "user",
            content: "Archive session for sidebar filtering",
          }),
          createMessageEntry({
            entryId: "archive-assistant-entry",
            messageId: "archive-assistant-message",
            parentId: "archive-user-entry",
            at: "2024-03-01T00:00:02.000Z",
            role: "assistant",
            stopReason: "endTurn",
            content: "Archive fixture available for search coverage.",
          }),
        ],
      }),
    },
  ];
}

function createSessionFile(options: {
  id: string;
  cwd: string;
  timestamp?: string;
  entries: Record<string, unknown>[];
}) {
  const header = {
    type: "session",
    version: 3,
    id: options.id,
    timestamp: options.timestamp ?? "2024-01-01T00:00:00.000Z",
    cwd: options.cwd,
  };

  return [header, ...options.entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function createMessageEntry(options: {
  entryId: string;
  messageId: string;
  parentId: string | null;
  at: string;
  role: string;
  content: unknown;
  stopReason?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}) {
  return {
    type: "message",
    id: options.entryId,
    parentId: options.parentId,
    timestamp: options.at,
    message: {
      id: options.messageId,
      role: options.role,
      content: options.content,
      timestamp: options.at,
      ...(options.stopReason ? { stopReason: options.stopReason } : {}),
      ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
      ...(options.toolName ? { toolName: options.toolName } : {}),
      ...(options.isError !== undefined ? { isError: options.isError } : {}),
    },
  };
}
