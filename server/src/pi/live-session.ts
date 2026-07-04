import type { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ApiExtensionUiResponse,
  ApiSessionPatch,
  ApiSessionSnapshot,
  ApiToolExecution,
  SessionEvent,
} from "@pi-web-app/shared";
import { ExtensionUiBridge } from "./extension-ui-bridge.js";
import { GlobalMutationTracker } from "./global-mutation-tracker.js";
import { createSnapshot, createSnapshotMetadata, serializeMessage } from "./serialize.js";

export type SessionSubscriber = (event: SessionEvent) => void;

type CreateAgentSessionResult = Awaited<ReturnType<typeof createAgentSession>>;
type AgentSession = CreateAgentSessionResult["session"];
type PiSessionManager = ReturnType<typeof SessionManager.create>;

const MAX_TOOL_EXECUTION_TEXT_CHARS = 32_000;
const TOOL_EXECUTION_TRUNCATION_MARKER = "\n\n… [tool output truncated in Pi Web]\n\n";
const EXPECTED_INTERNAL_WRITE_WINDOW_MS = 10_000;

export class LiveSession {
  readonly subscribers = new Set<SessionSubscriber>();
  readonly toolExecutions = new Map<string, ApiToolExecution>();

  externallyDirty = false;
  lastInternalUpdateAt = Date.now();

  private snapshot: ApiSessionSnapshot;
  private internalChangeExpectedUntil = Date.now();
  private contextUsage: ApiSessionSnapshot["contextUsage"];
  private isRefreshingContextUsage = false;
  private hasPendingContextUsageRefresh = false;
  private pendingMessageSequence = 0;
  private readonly pendingMessageIds = new Map<string, string>();
  private externalReloadTimeout: ReturnType<typeof setTimeout> | undefined;
  private isReloadingExternally = false;
  private hasPendingExternalReload = false;
  private readonly extensionUi: ExtensionUiBridge;
  private globalMutationTracker: GlobalMutationTracker | undefined;
  private unsubscribeFromSession: () => void;

  constructor(
    session: AgentSession,
    sessionManager: PiSessionManager,
    private readonly reloadPersistedSession: (sessionFile: string) => Promise<void>,
    globalMutationTracker?: GlobalMutationTracker,
  ) {
    this.session = session;
    this.sessionManager = sessionManager;
    this.contextUsage = undefined;
    this.globalMutationTracker = globalMutationTracker;
    this.unsubscribeFromSession = () => {};
    this.extensionUi = new ExtensionUiBridge(
      (event) => this.publish(event),
      () => this.session,
      () => this.getSessionCwd(),
    );
    this.subscribeToSession(session);
    this.snapshot = this.createCurrentSnapshot();
    void this.refreshContextUsage();
    void this.extensionUi.refreshAvailableProviderCount();
  }

  session: AgentSession;
  sessionManager: PiSessionManager;

  subscribe(subscriber: SessionSubscriber): () => void {
    this.subscribers.add(subscriber);
    if (this.hasPendingExternalReload && !this.externalReloadTimeout) {
      this.scheduleExternalReload();
    }
    subscriber({ type: "snapshot", snapshot: this.getSnapshot() });
    this.extensionUi.replayState(subscriber);
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

  setLayoutColumns(columns: number) {
    this.extensionUi.setLayoutColumns(columns);
  }

  setExtensionNotificationsSuppressed(suppressed: boolean) {
    this.extensionUi.setNotificationsSuppressed(suppressed);
  }

  setGlobalMutationTracker(globalMutationTracker: GlobalMutationTracker | undefined) {
    this.globalMutationTracker = globalMutationTracker;
  }

  releaseGlobalMutations() {
    this.globalMutationTracker?.release();
  }

  restoreGlobalMutations() {
    this.globalMutationTracker?.reapply();
  }

  publishSnapshot(markInternalUpdate = true) {
    this.markInternalUpdate(markInternalUpdate);
    this.snapshot = this.createCurrentSnapshot();
    this.publish({
      type: "snapshot",
      snapshot: this.snapshot,
    });
    this.extensionUi.renderDynamicUi();
    void this.refreshContextUsage();
    void this.extensionUi.refreshAvailableProviderCount();
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
    this.extensionUi.renderDynamicUi();
    void this.refreshContextUsage();
    void this.extensionUi.refreshAvailableProviderCount();
  }

  markExternalChange(options: { reloadImmediately?: boolean } = {}) {
    this.externallyDirty = true;
    this.hasPendingExternalReload = true;
    this.publishSessionPatch(false);
    if (options.reloadImmediately ?? true) {
      this.scheduleExternalReload();
    }
  }

  expectInternalSessionWrites(durationMs = EXPECTED_INTERNAL_WRITE_WINDOW_MS) {
    const now = Date.now();
    this.lastInternalUpdateAt = now;
    this.internalChangeExpectedUntil = Math.max(this.internalChangeExpectedUntil, now + durationMs);
  }

  isInternalChangeExpected(now = Date.now()) {
    return now <= this.internalChangeExpectedUntil;
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
      const now = Date.now();
      this.lastInternalUpdateAt = now;
      this.internalChangeExpectedUntil = now;
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
      this.compactCompletedToolExecution(serializedMessage.toolCallId, serializedMessage.role, false);
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
      this.compactCompletedToolExecution(serializedMessage.toolCallId, serializedMessage.role, false);
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

  private compactCompletedToolExecution(toolCallId: string | undefined, messageRole: string | undefined, markInternalUpdate = false) {
    if (messageRole !== "toolResult" || !toolCallId) {
      return;
    }

    const current = this.toolExecutions.get(toolCallId);
    if (!current || current.status === "running" || !current.text) {
      return;
    }

    current.text = "";
    this.publishToolExecutionDelta(current, markInternalUpdate);
  }

  private hasToolResultMessage(toolCallId: string | undefined) {
    if (!toolCallId) {
      return false;
    }

    return this.snapshot.messages.some((message) =>
      message.role === "toolResult" && message.toolCallId === toolCallId
    );
  }

  respondToUiRequest(response: ApiExtensionUiResponse) {
    this.extensionUi.respondToUiRequest(response);
  }

  private getSessionCwd() {
    const cwd = this.session?.sessionManager?.getCwd?.() ?? this.sessionManager?.getCwd?.();
    return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
  }

  createExtensionUiContext(options: { suppressNotifications?: boolean } = {}) {
    return this.extensionUi.createContext(options);
  }

  replaceSession(session: AgentSession, sessionManager: PiSessionManager, globalMutationTracker?: GlobalMutationTracker) {
    const previousSession = this.session;
    this.globalMutationTracker?.release();
    this.unsubscribeFromSession();
    this.extensionUi.cancelPendingUiRequests();

    this.session = session;
    this.sessionManager = sessionManager;
    this.globalMutationTracker = globalMutationTracker;
    this.pendingMessageIds.clear();
    this.pendingMessageSequence = 0;
    this.toolExecutions.clear();
    this.contextUsage = undefined;

    this.subscribeToSession(session);
    this.extensionUi.resetAfterSessionReplace();
    previousSession.dispose();
  }

  dispose() {
    this.globalMutationTracker?.release();
    this.globalMutationTracker = undefined;
    if (this.externalReloadTimeout) {
      clearTimeout(this.externalReloadTimeout);
      this.externalReloadTimeout = undefined;
    }
    this.extensionUi.dispose();
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

  private subscribeToSession(session: AgentSession) {
    this.unsubscribeFromSession = session.subscribe((event: any) => {
      this.handleSessionEvent(event);
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
          if (this.hasToolResultMessage(current.toolCallId)) {
            current.text = "";
          }
          current.updatedAt = new Date().toISOString();
          this.publishToolExecutionDelta(current);
        }
        break;
      }
      case "auto_compaction_end": {
        this.publishSnapshot();
        return;
      }
      case "agent_end": {
        void this.session.agent.waitForIdle().then(() => this.publishSessionPatch());
        break;
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

const truncateToolExecutionText = (value: string) => {
  if (value.length <= MAX_TOOL_EXECUTION_TEXT_CHARS) {
    return value;
  }

  const remainingBudget = MAX_TOOL_EXECUTION_TEXT_CHARS - TOOL_EXECUTION_TRUNCATION_MARKER.length;
  const headLength = Math.floor(remainingBudget * 0.7);
  const tailLength = Math.max(0, remainingBudget - headLength);

  return `${value.slice(0, headLength)}${TOOL_EXECUTION_TRUNCATION_MARKER}${value.slice(-tailLength)}`;
};

const stringifyToolOutput = (value: unknown): string => {
  if (typeof value === "string") {
    return truncateToolExecutionText(value);
  }
  if (value == null) return "";

  const serialized = JSON.stringify(
    value,
    (key, currentValue) => {
      if (key === "data" && typeof currentValue === "string") {
        return `[base64:${currentValue.length}]`;
      }
      return currentValue;
    },
    2,
  ) ?? "";

  return truncateToolExecutionText(serialized);
};
