import { randomUUID } from "node:crypto";
import type {
  ApiExtensionNotification,
  ApiExtensionUiRequest,
  ApiExtensionUiResponse,
  ApiSessionPatch,
  ApiSessionSnapshot,
  ApiToolExecution,
  SessionEvent,
} from "@pi-web-app/shared";
import { createSnapshot, createSnapshotMetadata, serializeMessage } from "./serialize.js";

export type SessionSubscriber = (event: SessionEvent) => void;

function normalizeExtensionWidgetContent(content: unknown): string[] | undefined {
  if (content == null) return undefined;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return undefined;
  return content.filter((line): line is string => typeof line === "string");
}

export class LiveSession {
  readonly subscribers = new Set<SessionSubscriber>();
  readonly toolExecutions = new Map<string, ApiToolExecution>();

  externallyDirty = false;
  lastInternalUpdateAt = Date.now();

  private snapshot: ApiSessionSnapshot;
  private contextUsage: ApiSessionSnapshot["contextUsage"];
  private isRefreshingContextUsage = false;
  private hasPendingContextUsageRefresh = false;
  private pendingMessageSequence = 0;
  private readonly pendingMessageIds = new Map<string, string>();
  private externalReloadTimeout: ReturnType<typeof setTimeout> | undefined;
  private isReloadingExternally = false;
  private hasPendingExternalReload = false;
  private readonly pendingUiRequests = new Map<
    string,
    {
      resolve: (response: ApiExtensionUiResponse) => void;
      timeoutId: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  private unsubscribeFromSession: () => void;

  constructor(
    session: any,
    sessionManager: any,
    private readonly reloadPersistedSession: (sessionFile: string) => Promise<void>,
  ) {
    this.session = session;
    this.sessionManager = sessionManager;
    this.contextUsage = undefined;
    this.unsubscribeFromSession = () => {};
    this.subscribeToSession(session);
    this.snapshot = this.createCurrentSnapshot();
    void this.refreshContextUsage();
  }

  session: any;
  sessionManager: any;

  subscribe(subscriber: SessionSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber({ type: "snapshot", snapshot: this.getSnapshot() });
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  getSnapshot() {
    this.syncSnapshotMetadata();
    return this.snapshot;
  }

  getSessionName(): string | undefined {
    const sessionManager = this.session?.sessionManager ?? this.sessionManager;
    const sessionName = sessionManager?.getSessionName?.();
    return typeof sessionName === "string" && sessionName.trim() ? sessionName : undefined;
  }

  publishSnapshot(markInternalUpdate = true) {
    this.markInternalUpdate(markInternalUpdate);
    this.snapshot = this.createCurrentSnapshot();
    this.publish({
      type: "snapshot",
      snapshot: this.snapshot,
    });
    void this.refreshContextUsage();
  }

  publishSessionPatch(markInternalUpdate = true) {
    this.markInternalUpdate(markInternalUpdate);
    const patch = this.syncSnapshotMetadata();
    if (patch) {
      this.publish({
        type: "session_patch",
        patch,
      });
    }
    void this.refreshContextUsage();
  }

  markExternalChange() {
    this.externallyDirty = true;
    this.hasPendingExternalReload = true;
    this.publishSessionPatch(false);
    this.scheduleExternalReload();
  }

  resetAfterSessionMutation() {
    this.externallyDirty = false;
    this.toolExecutions.clear();
    this.publishSnapshot();
  }

  publish(event: SessionEvent) {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  private createCurrentSnapshot() {
    return createSnapshot({
      session: this.session,
      sessionName: this.getSessionName(),
      toolExecutions: this.toolExecutions,
      externallyDirty: this.externallyDirty,
      contextUsage: this.contextUsage,
    });
  }

  private markInternalUpdate(markInternalUpdate: boolean) {
    if (markInternalUpdate) {
      this.lastInternalUpdateAt = Date.now();
    }
  }

  private scheduleExternalReload() {
    if (this.externalReloadTimeout) {
      clearTimeout(this.externalReloadTimeout);
    }
    this.externalReloadTimeout = setTimeout(() => {
      this.externalReloadTimeout = undefined;
      void this.reloadExternalChanges();
    }, 150);
  }

  private syncSnapshotMetadata(): ApiSessionPatch | undefined {
    const nextSessionFile = this.session.sessionFile ? String(this.session.sessionFile) : undefined;
    const nextMetadata = createSnapshotMetadata({
      session: this.session,
      sessionName: this.getSessionName(),
      sessionFile: nextSessionFile ?? this.snapshot.sessionFile,
      messages: this.snapshot.messages,
      externallyDirty: this.externallyDirty,
      contextUsage: this.contextUsage,
    });
    const patch: ApiSessionPatch = {};

    if (nextSessionFile !== this.snapshot.sessionFile) {
      this.snapshot.sessionFile = nextSessionFile;
      patch.sessionFile = nextSessionFile;
    }
    if (nextMetadata.title !== this.snapshot.title) {
      this.snapshot.title = nextMetadata.title;
      patch.title = nextMetadata.title;
    }
    if (nextMetadata.status !== this.snapshot.status) {
      this.snapshot.status = nextMetadata.status;
      patch.status = nextMetadata.status;
    }
    if (nextMetadata.live !== this.snapshot.live) {
      this.snapshot.live = nextMetadata.live;
      patch.live = nextMetadata.live;
    }
    if (nextMetadata.externallyDirty !== this.snapshot.externallyDirty) {
      this.snapshot.externallyDirty = nextMetadata.externallyDirty;
      patch.externallyDirty = nextMetadata.externallyDirty;
    }
    if (!modelsEqual(nextMetadata.model, this.snapshot.model)) {
      this.snapshot.model = nextMetadata.model;
      patch.model = nextMetadata.model;
    }
    if (nextMetadata.thinkingLevel !== this.snapshot.thinkingLevel) {
      this.snapshot.thinkingLevel = nextMetadata.thinkingLevel;
      patch.thinkingLevel = nextMetadata.thinkingLevel;
    }
    if (!contextUsageEqual(nextMetadata.contextUsage, this.snapshot.contextUsage)) {
      this.snapshot.contextUsage = nextMetadata.contextUsage;
      patch.contextUsage = nextMetadata.contextUsage;
    }

    return Object.keys(patch).length > 0 ? patch : undefined;
  }

  private publishMessagesDelta(fromIndex: number, markInternalUpdate = true) {
    this.markInternalUpdate(markInternalUpdate);
    this.publish({
      type: "messages_delta",
      fromIndex,
      messages: this.snapshot.messages.slice(fromIndex),
    });
  }

  private upsertSnapshotMessage(message: any, eventType: string) {
    const fallbackIndex = this.session.messages?.findIndex((candidate: any) => candidate === message)
      ?? this.session.agent?.state?.messages?.findIndex((candidate: any) => candidate === message)
      ?? -1;
    const messageRole = typeof message?.role === "string" && message.role.trim() ? message.role.trim() : "message";
    const pendingMessageId = this.pendingMessageIds.get(messageRole);
    const messageId = typeof message?.id === "string" && message.id.trim()
      ? message.id.trim()
      : fallbackIndex >= 0
        ? `${messageRole}-${fallbackIndex}`
        : pendingMessageId ?? `pending-${messageRole}-${this.pendingMessageSequence++}`;

    if (!pendingMessageId && fallbackIndex < 0) {
      this.pendingMessageIds.set(messageRole, messageId);
    }

    const serializedMessage = serializeMessage(message, Math.max(fallbackIndex, 0));
    if (serializedMessage) {
      serializedMessage.id = messageId;
    }

    let existingIndex = this.snapshot.messages.findIndex((entry) => entry.id === messageId);
    if (existingIndex === -1 && pendingMessageId && pendingMessageId !== messageId) {
      existingIndex = this.snapshot.messages.findIndex((entry) => entry.id === pendingMessageId);
    }

    if (!serializedMessage) {
      if (eventType === "message_end") {
        this.pendingMessageIds.delete(messageRole);
      }
      if (existingIndex === -1) {
        return "none" as const;
      }
      this.snapshot.messages = [
        ...this.snapshot.messages.slice(0, existingIndex),
        ...this.snapshot.messages.slice(existingIndex + 1),
      ];
      this.publishMessagesDelta(existingIndex);
      return "delta" as const;
    }

    if (existingIndex === -1) {
      this.snapshot.messages = [...this.snapshot.messages, serializedMessage];
      this.publishMessagesDelta(this.snapshot.messages.length - 1);
    } else {
      const current = this.snapshot.messages[existingIndex];
      if (
        current?.id === serializedMessage.id &&
        current.role === serializedMessage.role &&
        current.text === serializedMessage.text &&
        current.timestamp === serializedMessage.timestamp
      ) {
        if (fallbackIndex >= 0 || eventType === "message_end") {
          this.pendingMessageIds.delete(messageRole);
        }
        return "none" as const;
      }

      this.snapshot.messages = [
        ...this.snapshot.messages.slice(0, existingIndex),
        serializedMessage,
        ...this.snapshot.messages.slice(existingIndex + 1),
      ];
      this.publishMessagesDelta(existingIndex);
    }

    if (fallbackIndex >= 0 || eventType === "message_end") {
      this.pendingMessageIds.delete(messageRole);
    }
    return "delta" as const;
  }

  private publishToolExecutionDelta(toolExecution: ApiToolExecution, markInternalUpdate = true) {
    this.markInternalUpdate(markInternalUpdate);
    this.snapshot.toolExecutions = [...this.toolExecutions.values()].sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt),
    );
    this.publish({
      type: "tool_execution_delta",
      toolExecution,
    });
  }

  respondToUiRequest(response: ApiExtensionUiResponse) {
    const pendingRequest = this.pendingUiRequests.get(response.id);
    if (!pendingRequest) {
      throw new Error(`Pending extension UI request not found: ${response.id}`);
    }

    this.pendingUiRequests.delete(response.id);
    if (pendingRequest.timeoutId) {
      clearTimeout(pendingRequest.timeoutId);
    }
    pendingRequest.resolve(response);
  }

  createExtensionUiContext() {
    const theme = {
      name: "web-ui",
      mode: "dark",
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
    };

    return {
      select: (title: string, options: string[], opts?: { timeout?: number; signal?: AbortSignal }) =>
        this.createDialogPromise<string | undefined>(
          {
            method: "select",
            title,
            options,
            timeout: opts?.timeout,
          },
          undefined,
          opts,
          (response) => response.cancelled ? undefined : response.value,
        ),
      confirm: (title: string, message: string, opts?: { timeout?: number; signal?: AbortSignal }) =>
        this.createDialogPromise<boolean>(
          {
            method: "confirm",
            title,
            message,
            timeout: opts?.timeout,
          },
          false,
          opts,
          (response) => response.cancelled ? false : Boolean(response.confirmed),
        ),
      input: (title: string, placeholder?: string, opts?: { timeout?: number; signal?: AbortSignal }) =>
        this.createDialogPromise<string | undefined>(
          {
            method: "input",
            title,
            placeholder,
            timeout: opts?.timeout,
          },
          undefined,
          opts,
          (response) => response.cancelled ? undefined : response.value,
        ),
      editor: (title: string, prefill?: string, opts?: { timeout?: number; signal?: AbortSignal }) =>
        this.createDialogPromise<string | undefined>(
          {
            method: "editor",
            title,
            prefill,
            timeout: opts?.timeout,
          },
          undefined,
          opts,
          (response) => response.cancelled ? undefined : response.value,
        ),
      notify: (message: string, notifyType?: "info" | "warning" | "error") => {
        const notification: ApiExtensionNotification = {
          id: randomUUID(),
          message,
          notifyType: notifyType ?? "info",
        };

        this.publish({
          type: "extension_notify",
          notification,
        });
      },
      onTerminalInput: () => () => {},
      setStatus: (key: string, text?: string) => {
        this.publish({
          type: "set_status",
          key,
          text,
        });
      },
      setWorkingMessage: () => {},
      setWidget: (key: string, content?: string | readonly string[], options?: { placement?: "aboveEditor" | "belowEditor" }) => {
        const normalizedContent = normalizeExtensionWidgetContent(content);
        this.publish({
          type: "set_widget",
          key,
          widget: normalizedContent
            ? {
                key,
                lines: normalizedContent,
                placement: options?.placement ?? "aboveEditor",
              }
            : undefined,
        });
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title: string) => {
        this.publish({
          type: "set_title",
          title,
        });
      },
      custom: async () => undefined,
      pasteToEditor: (text: string) => {
        this.publish({ type: "set_editor_text", text });
      },
      setEditorText: (text: string) => {
        this.publish({ type: "set_editor_text", text });
      },
      getEditorText: () => "",
      setEditorComponent: () => {},
      get theme() {
        return theme;
      },
      getAllThemes: () => [],
      getTheme: () => theme,
      setTheme: () => ({ success: true }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  replaceSession(session: any, sessionManager: any) {
    const previousSession = this.session;
    this.unsubscribeFromSession();
    this.cancelPendingUiRequests();

    this.session = session;
    this.sessionManager = sessionManager;
    this.pendingMessageIds.clear();
    this.pendingMessageSequence = 0;
    this.toolExecutions.clear();
    this.contextUsage = undefined;

    this.subscribeToSession(session);
    previousSession.dispose();
  }

  dispose() {
    if (this.externalReloadTimeout) {
      clearTimeout(this.externalReloadTimeout);
      this.externalReloadTimeout = undefined;
    }
    this.cancelPendingUiRequests();
    this.subscribers.clear();
    this.unsubscribeFromSession();
    this.session.dispose();
  }

  private async reloadExternalChanges() {
    if (this.isReloadingExternally) {
      return;
    }
    if (this.session.isStreaming) {
      this.scheduleExternalReload();
      return;
    }

    this.isReloadingExternally = true;
    try {
      while (this.hasPendingExternalReload) {
        this.hasPendingExternalReload = false;
        await this.syncSessionStateFromDisk();
      }

      this.toolExecutions.clear();
      this.externallyDirty = false;
      this.publishSnapshot(false);
    } catch {
      this.externallyDirty = true;
      this.publishSnapshot(false);
    } finally {
      this.isReloadingExternally = false;
      if (this.hasPendingExternalReload && !this.externalReloadTimeout) {
        this.scheduleExternalReload();
      }
    }
  }

  private async syncSessionStateFromDisk() {
    const sessionFile = typeof this.session.sessionFile === "string" ? this.session.sessionFile : undefined;
    if (!sessionFile) {
      return;
    }

    await this.reloadPersistedSession(sessionFile);
  }

  private subscribeToSession(session: any) {
    this.unsubscribeFromSession = session.subscribe((event: any) => {
      this.handleSessionEvent(event);
    });
  }

  private cancelPendingUiRequests() {
    for (const [requestId, pendingRequest] of this.pendingUiRequests) {
      if (pendingRequest.timeoutId) {
        clearTimeout(pendingRequest.timeoutId);
      }
      pendingRequest.resolve({
        id: requestId,
        value: undefined,
        confirmed: undefined,
        cancelled: true,
      });
    }
    this.pendingUiRequests.clear();
  }

  private createDialogPromise<T>(
    request: Omit<ApiExtensionUiRequest, "id" | "message" | "options" | "placeholder" | "prefill"> &
      Partial<Pick<ApiExtensionUiRequest, "message" | "options" | "placeholder" | "prefill">>,
    defaultValue: T,
    options: { timeout?: number; signal?: AbortSignal } | undefined,
    parseResponse: (response: ApiExtensionUiResponse) => T,
  ) {
    if (options?.signal?.aborted) {
      return Promise.resolve(defaultValue);
    }

    const id = randomUUID();

    return new Promise<T>((resolve) => {
      const cleanup = () => {
        const pendingRequest = this.pendingUiRequests.get(id);
        if (!pendingRequest) return;
        if (pendingRequest.timeoutId) {
          clearTimeout(pendingRequest.timeoutId);
        }
        this.pendingUiRequests.delete(id);
        options?.signal?.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        cleanup();
        resolve(defaultValue);
      };

      options?.signal?.addEventListener("abort", onAbort, { once: true });

      const timeoutId = options?.timeout
        ? setTimeout(() => {
            cleanup();
            resolve(defaultValue);
          }, options.timeout)
        : undefined;

      this.pendingUiRequests.set(id, {
        timeoutId,
        resolve: (response) => {
          cleanup();
          resolve(parseResponse(response));
        },
      });

      this.publish({
        type: "extension_ui_request",
        request: {
          id,
          method: request.method,
          title: request.title,
          message: request.message,
          options: request.options,
          placeholder: request.placeholder,
          prefill: request.prefill,
          timeout: request.timeout,
        },
      });
    });
  }

  private async refreshContextUsage() {
    if (typeof this.session.getContextUsage !== "function") {
      return;
    }
    if (this.isRefreshingContextUsage) {
      this.hasPendingContextUsageRefresh = true;
      return;
    }

    this.isRefreshingContextUsage = true;
    try {
      do {
        this.hasPendingContextUsageRefresh = false;
        const nextContextUsage = normalizeContextUsage(await this.session.getContextUsage());
        this.contextUsage = nextContextUsage;

        if (!contextUsageEqual(nextContextUsage, this.snapshot.contextUsage)) {
          this.snapshot.contextUsage = nextContextUsage;
          this.publish({
            type: "session_patch",
            patch: { contextUsage: nextContextUsage },
          });
        }
      } while (this.hasPendingContextUsageRefresh);
    } catch {
      this.hasPendingContextUsageRefresh = false;
    } finally {
      this.isRefreshingContextUsage = false;
    }
  }

  private handleSessionEvent(event: any) {
    switch (event.type) {
      case "message_start":
      case "message_update":
      case "message_end": {
        if (event.message) {
          this.upsertSnapshotMessage(event.message, event.type);
        }
        break;
      }
      case "tool_execution_start": {
        const now = new Date().toISOString();
        const toolExecution: ApiToolExecution = {
          toolCallId: String(event.toolCallId),
          toolName: String(event.toolName),
          status: "running",
          text: "",
          startedAt: now,
          updatedAt: now,
        };
        this.toolExecutions.set(toolExecution.toolCallId, toolExecution);
        this.publishToolExecutionDelta(toolExecution);
        break;
      }
      case "tool_execution_update": {
        const current = this.toolExecutions.get(String(event.toolCallId));
        if (current) {
          current.text = stringifyToolOutput(event.partialResult);
          current.updatedAt = new Date().toISOString();
          this.publishToolExecutionDelta(current);
        }
        break;
      }
      case "tool_execution_end": {
        const current = this.toolExecutions.get(String(event.toolCallId));
        if (current) {
          current.status = event.isError ? "error" : "done";
          current.text = stringifyToolOutput(event.result);
          current.updatedAt = new Date().toISOString();
          this.publishToolExecutionDelta(current);
        }
        break;
      }
      case "auto_compaction_end": {
        this.publishSnapshot();
        return;
      }
      default:
        break;
    }

    this.publishSessionPatch();
  }
}

const modelsEqual = (left: ApiSessionSnapshot["model"], right: ApiSessionSnapshot["model"]) =>
  left?.provider === right?.provider && left?.id === right?.id && left?.name === right?.name;

const contextUsageEqual = (
  left: ApiSessionSnapshot["contextUsage"],
  right: ApiSessionSnapshot["contextUsage"],
) =>
  left?.tokens === right?.tokens
  && left?.contextWindow === right?.contextWindow
  && left?.percent === right?.percent;

const normalizeContextUsage = (contextUsage: unknown): ApiSessionSnapshot["contextUsage"] => {
  if (!contextUsage || typeof contextUsage !== "object") {
    return undefined;
  }

  const tokens = Number((contextUsage as { tokens?: unknown }).tokens);
  const contextWindow = Number((contextUsage as { contextWindow?: unknown }).contextWindow);
  const percent = Number((contextUsage as { percent?: unknown }).percent);

  if (!Number.isFinite(tokens) || !Number.isFinite(contextWindow) || !Number.isFinite(percent)) {
    return undefined;
  }

  return {
    tokens,
    contextWindow,
    percent,
  };
};

const stringifyToolOutput = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value == null) return "";

  return JSON.stringify(
    value,
    (key, currentValue) => {
      if (key === "data" && typeof currentValue === "string") {
        return `[base64:${currentValue.length}]`;
      }
      return currentValue;
    },
    2,
  );
};
