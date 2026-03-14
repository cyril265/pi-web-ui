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

export interface ApiSessionSnapshot {
  sessionId: string;
  sessionFile: string | undefined;
  title: string;
  status: SessionStatus;
  live: boolean;
  externallyDirty: boolean;
  model: ApiModelInfo | undefined;
  thinkingLevel: ThinkingLevel;
  messages: ApiMessage[];
  toolExecutions: ApiToolExecution[];
}

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
