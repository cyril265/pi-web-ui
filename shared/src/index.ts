export type SessionStatus = "idle" | "streaming" | "error";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | string;

export interface ApiModelInfo {
  provider: string;
  id: string;
  name: string;
}

export interface ApiImageInput {
  mimeType: string;
  data: string;
  fileName: string;
}

export interface ApiMessage {
  id: string;
  role: string;
  text: string;
  timestamp: string | undefined;
  isError?: boolean;
}

export interface ApiToolExecution {
  toolCallId: string;
  toolName: string;
  status: "running" | "done" | "error";
  text: string;
  startedAt: string;
  updatedAt: string;
}

export interface ApiForkMessage {
  entryId: string;
  text: string;
}

export interface ApiTreeMessage {
  entryId: string;
  text: string;
  isOnCurrentPath: boolean;
}

export interface ApiSessionListItem {
  id: string;
  sessionFile: string | undefined;
  cwd: string | undefined;
  isInCurrentWorkspace: boolean;
  title: string;
  preview: string;
  lastModified: string | undefined;
  messageCount: number;
  modelId: string | undefined;
  thinkingLevel: string | undefined;
  status: SessionStatus;
  live: boolean;
  externallyDirty: boolean;
}

export interface ApiContextUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

export interface ApiSessionSnapshot {
  sessionId: string;
  sessionFile: string | undefined;
  title: string;
  status: SessionStatus;
  live: boolean;
  externallyDirty: boolean;
  model: ApiModelInfo | undefined;
  thinkingLevel: ThinkingLevel;
  contextUsage: ApiContextUsage | undefined;
  messages: ApiMessage[];
  toolExecutions: ApiToolExecution[];
}

export interface ApiSessionPatch {
  sessionFile?: string | undefined;
  title?: string;
  status?: SessionStatus;
  live?: boolean;
  externallyDirty?: boolean;
  model?: ApiModelInfo | undefined;
  thinkingLevel?: ThinkingLevel;
  contextUsage?: ApiContextUsage | undefined;
}

export type ApiSlashCommandSource = "builtin" | "extension" | "prompt" | "skill";
export type ApiSlashCommandLocation = "user" | "project" | "path";

export interface ApiSlashCommand {
  name: string;
  description?: string;
  source: ApiSlashCommandSource;
  location?: ApiSlashCommandLocation;
  path?: string;
}

export const BUILTIN_SLASH_COMMANDS: readonly ApiSlashCommand[] = [
  { name: "settings", description: "Open settings menu", source: "builtin" },
  { name: "model", description: "Select model (opens selector UI)", source: "builtin" },
  { name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling", source: "builtin" },
  { name: "export", description: "Export session to HTML file", source: "builtin" },
  { name: "share", description: "Share session as a secret GitHub gist", source: "builtin" },
  { name: "copy", description: "Copy last agent message to clipboard", source: "builtin" },
  { name: "name", description: "Set session display name", source: "builtin" },
  { name: "session", description: "Show session info and stats", source: "builtin" },
  { name: "changelog", description: "Show changelog entries", source: "builtin" },
  { name: "hotkeys", description: "Show all keyboard shortcuts", source: "builtin" },
  { name: "fork", description: "Create a new fork from a previous message", source: "builtin" },
  { name: "tree", description: "Navigate session tree (switch branches)", source: "builtin" },
  { name: "login", description: "Login with OAuth provider", source: "builtin" },
  { name: "logout", description: "Logout from OAuth provider", source: "builtin" },
  { name: "new", description: "Start a new session", source: "builtin" },
  { name: "compact", description: "Manually compact the session context", source: "builtin" },
  { name: "resume", description: "Resume a different session", source: "builtin" },
  { name: "reload", description: "Reload extensions, skills, prompts, and themes", source: "builtin" },
  { name: "quit", description: "Quit pi", source: "builtin" },
];

export interface ApiExtensionUiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message: string | undefined;
  options: string[] | undefined;
  placeholder: string | undefined;
  prefill: string | undefined;
  timeout: number | undefined;
}

export interface ApiExtensionUiResponse {
  id: string;
  value: string | undefined;
  confirmed: boolean | undefined;
  cancelled: boolean | undefined;
}

export interface ApiExtensionNotification {
  id: string;
  message: string;
  notifyType: "info" | "warning" | "error";
}

export interface ApiExtensionStatusEntry {
  key: string;
  text: string;
}

export interface ApiExtensionWidget {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export type SessionEvent =
  | {
      type: "snapshot";
      snapshot: ApiSessionSnapshot;
    }
  | {
      type: "session_patch";
      patch: ApiSessionPatch;
    }
  | {
      type: "messages_delta";
      fromIndex: number;
      messages: ApiMessage[];
    }
  | {
      type: "tool_execution_delta";
      toolExecution: ApiToolExecution;
    }
  | {
      type: "error";
      message: string;
    }
  | {
      type: "info";
      message: string;
    }
  | {
      type: "extension_ui_request";
      request: ApiExtensionUiRequest;
    }
  | {
      type: "extension_notify";
      notification: ApiExtensionNotification;
    }
  | {
      type: "set_editor_text";
      text: string;
    }
  | {
      type: "set_status";
      key: string;
      text: string | undefined;
    }
  | {
      type: "set_widget";
      widget: ApiExtensionWidget | undefined;
      key: string;
    }
  | {
      type: "set_title";
      title: string;
    };
