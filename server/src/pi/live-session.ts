import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  ApiExtensionNotification,
  ApiExtensionSurface,
  ApiExtensionUiRequest,
  ApiExtensionUiResponse,
  ApiExtensionWidget,
  ApiSessionPatch,
  ApiSessionSnapshot,
  ApiToolExecution,
  SessionEvent,
} from "@pi-web-app/shared";
import { GlobalMutationTracker } from "./global-mutation-tracker.js";
import { createSnapshot, createSnapshotMetadata, serializeMessage } from "./serialize.js";

export type SessionSubscriber = (event: SessionEvent) => void;

type ExtensionRenderableComponent = {
  render: (width: number) => unknown;
  invalidate?: () => void;
  dispose?: () => void;
};

type ExtensionRenderableWidget = {
  key: string;
  placement: ApiExtensionWidget["placement"];
  lines?: string[];
  component?: ExtensionRenderableComponent;
  renderedLines?: string[];
};

function normalizeExtensionWidgetContent(content: unknown): string[] | undefined {
  if (content == null) return undefined;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return undefined;
  return content.filter((line): line is string => typeof line === "string");
}

function normalizeRenderedLines(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((line): line is string => typeof line === "string");
}

function isRenderableComponent(value: unknown): value is ExtensionRenderableComponent {
  return typeof value === "object" && value !== null && typeof (value as { render?: unknown }).render === "function";
}

function linesEqual(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((line, index) => line === right[index]);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const MAX_TOOL_EXECUTION_TEXT_CHARS = 32_000;
const TOOL_EXECUTION_TRUNCATION_MARKER = "\n\n… [tool output truncated in Pi Web]\n\n";
const EXPECTED_INTERNAL_WRITE_WINDOW_MS = 10_000;
const DEFAULT_EXTENSION_RENDER_COLUMNS = 100;
const MIN_EXTENSION_RENDER_COLUMNS = 40;
const MAX_EXTENSION_RENDER_COLUMNS = 240;
const GIT_BRANCH_POLL_INTERVAL_MS = 3_000;

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
  private readonly pendingUiRequests = new Map<
    string,
    {
      resolve: (response: ApiExtensionUiResponse) => void;
      timeoutId: ReturnType<typeof setTimeout> | undefined;
    }
  >();
  private readonly extensionStatuses = new Map<string, string>();
  private readonly extensionWidgets = new Map<string, ExtensionRenderableWidget>();
  private readonly extensionBranchChangeListeners = new Set<() => void>();
  private extensionHeader: { component: ExtensionRenderableComponent; renderedLines?: string[] } | undefined;
  private extensionFooter: { component: ExtensionRenderableComponent; renderedLines?: string[] } | undefined;
  private extensionTitle: string | undefined;
  private extensionBranchPollInterval: ReturnType<typeof setInterval> | undefined;
  private cachedGitBranch: string | null | undefined;
  private availableProviderCount = 1;
  private renderColumns = DEFAULT_EXTENSION_RENDER_COLUMNS;
  private globalMutationTracker: GlobalMutationTracker | undefined;
  private unsubscribeFromSession: () => void;

  constructor(
    session: any,
    sessionManager: any,
    private readonly reloadPersistedSession: (sessionFile: string) => Promise<void>,
    globalMutationTracker?: GlobalMutationTracker,
  ) {
    this.session = session;
    this.sessionManager = sessionManager;
    this.contextUsage = undefined;
    this.globalMutationTracker = globalMutationTracker;
    this.unsubscribeFromSession = () => {};
    this.subscribeToSession(session);
    this.snapshot = this.createCurrentSnapshot();
    void this.refreshContextUsage();
    void this.refreshAvailableProviderCount();
  }

  session: any;
  sessionManager: any;

  subscribe(subscriber: SessionSubscriber): () => void {
    this.subscribers.add(subscriber);
    if (this.hasPendingExternalReload && !this.externalReloadTimeout) {
      this.scheduleExternalReload();
    }
    subscriber({ type: "snapshot", snapshot: this.getSnapshot() });
    this.replayExtensionUiState(subscriber);
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
    const normalizedColumns = Math.max(
      MIN_EXTENSION_RENDER_COLUMNS,
      Math.min(MAX_EXTENSION_RENDER_COLUMNS, Math.round(columns || DEFAULT_EXTENSION_RENDER_COLUMNS)),
    );

    if (this.renderColumns === normalizedColumns) {
      return;
    }

    this.renderColumns = normalizedColumns;
    this.renderDynamicExtensionUi();
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
    this.renderDynamicExtensionUi();
    void this.refreshContextUsage();
    void this.refreshAvailableProviderCount();
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
    this.renderDynamicExtensionUi();
    void this.refreshContextUsage();
    void this.refreshAvailableProviderCount();
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

  private replayExtensionUiState(subscriber: SessionSubscriber) {
    if (this.extensionTitle) {
      subscriber({ type: "set_title", title: this.extensionTitle });
    }
    if (this.extensionHeader) {
      subscriber({ type: "set_header", header: { lines: this.extensionHeader.renderedLines ?? [] } });
    }
    if (this.extensionFooter) {
      subscriber({ type: "set_footer", footer: { lines: this.extensionFooter.renderedLines ?? [] } });
    }
    for (const [key, text] of this.extensionStatuses) {
      subscriber({ type: "set_status", key, text });
    }
    for (const widget of this.extensionWidgets.values()) {
      subscriber({
        type: "set_widget",
        key: widget.key,
        widget: {
          key: widget.key,
          placement: widget.placement,
          lines: widget.component ? (widget.renderedLines ?? []) : (widget.lines ?? []),
        },
      });
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

  private getSessionCwd() {
    const cwd = this.session?.sessionManager?.getCwd?.() ?? this.sessionManager?.getCwd?.();
    return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
  }

  private resolveGitBranch() {
    const cwd = this.getSessionCwd();
    if (!cwd) {
      return null;
    }

    try {
      const branch = execFileSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return branch || null;
    } catch {
      return null;
    }
  }

  private getGitBranch() {
    const branch = this.resolveGitBranch();
    this.cachedGitBranch = branch;
    return branch;
  }

  private ensureBranchPolling() {
    if (this.extensionBranchPollInterval || this.extensionBranchChangeListeners.size === 0) {
      return;
    }

    this.cachedGitBranch = this.resolveGitBranch();
    this.extensionBranchPollInterval = setInterval(() => {
      const nextBranch = this.resolveGitBranch();
      if (nextBranch === this.cachedGitBranch) {
        return;
      }

      this.cachedGitBranch = nextBranch;
      for (const listener of this.extensionBranchChangeListeners) {
        listener();
      }
    }, GIT_BRANCH_POLL_INTERVAL_MS);
    this.extensionBranchPollInterval.unref?.();
  }

  private stopBranchPollingIfIdle() {
    if (this.extensionBranchChangeListeners.size > 0 || !this.extensionBranchPollInterval) {
      return;
    }

    clearInterval(this.extensionBranchPollInterval);
    this.extensionBranchPollInterval = undefined;
  }

  private onExtensionBranchChange(listener: () => void) {
    this.extensionBranchChangeListeners.add(listener);
    this.ensureBranchPolling();
    return () => {
      this.extensionBranchChangeListeners.delete(listener);
      this.stopBranchPollingIfIdle();
    };
  }

  private async refreshAvailableProviderCount() {
    const getAvailable = this.session?.modelRegistry?.getAvailable;
    if (typeof getAvailable !== "function") {
      return;
    }

    try {
      const models = await getAvailable.call(this.session.modelRegistry);
      if (!Array.isArray(models)) {
        return;
      }

      const nextCount = new Set(
        models
          .map((model: any) => typeof model?.provider === "string" ? model.provider : undefined)
          .filter((provider): provider is string => Boolean(provider)),
      ).size;

      if (!nextCount || nextCount === this.availableProviderCount) {
        return;
      }

      this.availableProviderCount = nextCount;
      this.renderDynamicExtensionUi();
    } catch {
      // Ignore model registry refresh failures in web-ui bridge.
    }
  }

  private renderExtensionComponent(component: ExtensionRenderableComponent, label: string) {
    try {
      return normalizeRenderedLines(component.render(this.renderColumns));
    } catch (error) {
      return [`${label} error: ${getErrorMessage(error)}`];
    }
  }

  private disposeExtensionWidget(key: string) {
    const existing = this.extensionWidgets.get(key);
    existing?.component?.dispose?.();
  }

  private setRenderedHeader(surface: ApiExtensionSurface | undefined) {
    this.publish({ type: "set_header", header: surface });
  }

  private setRenderedFooter(surface: ApiExtensionSurface | undefined) {
    this.publish({ type: "set_footer", footer: surface });
  }

  private renderExtensionHeader(forcePublish = false) {
    if (!this.extensionHeader) {
      if (forcePublish) {
        this.setRenderedHeader(undefined);
      }
      return;
    }

    const lines = this.renderExtensionComponent(this.extensionHeader.component, "header");
    if (!forcePublish && linesEqual(this.extensionHeader.renderedLines, lines)) {
      return;
    }

    this.extensionHeader.renderedLines = lines;
    this.setRenderedHeader({ lines });
  }

  private renderExtensionFooter(forcePublish = false) {
    if (!this.extensionFooter) {
      if (forcePublish) {
        this.setRenderedFooter(undefined);
      }
      return;
    }

    const lines = this.renderExtensionComponent(this.extensionFooter.component, "footer");
    if (!forcePublish && linesEqual(this.extensionFooter.renderedLines, lines)) {
      return;
    }

    this.extensionFooter.renderedLines = lines;
    this.setRenderedFooter({ lines });
  }

  private renderExtensionWidget(key: string, forcePublish = false) {
    const widget = this.extensionWidgets.get(key);
    if (!widget) {
      if (forcePublish) {
        this.publish({ type: "set_widget", key, widget: undefined });
      }
      return;
    }

    if (!widget.component) {
      if (forcePublish || widget.lines !== undefined) {
        this.publish({
          type: "set_widget",
          key,
          widget: {
            key,
            placement: widget.placement,
            lines: widget.lines ?? [],
          },
        });
      }
      return;
    }

    const lines = this.renderExtensionComponent(widget.component, `widget:${key}`);
    if (!forcePublish && linesEqual(widget.renderedLines, lines)) {
      return;
    }

    widget.renderedLines = lines;
    this.publish({
      type: "set_widget",
      key,
      widget: {
        key,
        placement: widget.placement,
        lines,
      },
    });
  }

  private renderDynamicExtensionUi() {
    this.renderExtensionHeader();
    this.renderExtensionFooter();
    for (const widget of this.extensionWidgets.values()) {
      if (widget.component) {
        this.renderExtensionWidget(widget.key);
      }
    }
  }

  createExtensionUiContext(options: { suppressNotifications?: boolean } = {}) {
    const passthroughThemeStyle = (...args: unknown[]) => {
      for (let index = args.length - 1; index >= 0; index -= 1) {
        const value = args[index];
        if (typeof value === "string") {
          return value;
        }
      }
      return "";
    };

    const theme = new Proxy({
      name: "web-ui",
      mode: "dark",
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
    }, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (value !== undefined || typeof property === "symbol") {
          return value;
        }
        return passthroughThemeStyle;
      },
    });

    const extensionTui = {
      requestRender: () => {
        this.renderDynamicExtensionUi();
      },
    };

    const footerData = {
      getGitBranch: () => this.getGitBranch(),
      getExtensionStatuses: () => this.extensionStatuses,
      getAvailableProviderCount: () => this.availableProviderCount,
      onBranchChange: (listener: () => void) => this.onExtensionBranchChange(listener),
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
        if (options.suppressNotifications) {
          return;
        }

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
        if (text === undefined) {
          this.extensionStatuses.delete(key);
        } else {
          this.extensionStatuses.set(key, text);
        }

        this.publish({
          type: "set_status",
          key,
          text,
        });
        this.renderExtensionFooter();
      },
      setWorkingMessage: () => {},
      setWidget: (
        key: string,
        content?: string | readonly string[] | ((tui: unknown, thm: unknown) => unknown),
        options?: { placement?: "aboveEditor" | "belowEditor" },
      ) => {
        const placement = options?.placement ?? "aboveEditor";
        this.disposeExtensionWidget(key);

        if (typeof content === "function") {
          try {
            const instance = content(extensionTui, theme);
            if (!isRenderableComponent(instance)) {
              this.extensionWidgets.delete(key);
              this.publish({ type: "set_widget", key, widget: undefined });
              return;
            }

            this.extensionWidgets.set(key, {
              key,
              placement,
              component: instance,
            });
            this.renderExtensionWidget(key, true);
          } catch (error) {
            this.extensionWidgets.set(key, {
              key,
              placement,
              lines: [`widget:${key} error: ${getErrorMessage(error)}`],
            });
            this.renderExtensionWidget(key, true);
          }
          return;
        }

        const normalizedContent = normalizeExtensionWidgetContent(content);
        if (!normalizedContent) {
          this.extensionWidgets.delete(key);
          this.publish({ type: "set_widget", key, widget: undefined });
          return;
        }

        this.extensionWidgets.set(key, {
          key,
          placement,
          lines: normalizedContent,
        });
        this.renderExtensionWidget(key, true);
      },
      setFooter: (
        factory?: (tui: unknown, thm: unknown, footerDataProvider: typeof footerData) => unknown,
      ) => {
        this.extensionFooter?.component.dispose?.();
        this.extensionFooter = undefined;

        if (!factory) {
          this.setRenderedFooter(undefined);
          return;
        }

        try {
          const instance = factory(extensionTui, theme, footerData);
          if (!isRenderableComponent(instance)) {
            this.setRenderedFooter({ lines: ["footer error: factory returned invalid component"] });
            return;
          }

          this.extensionFooter = { component: instance };
          this.renderExtensionFooter(true);
        } catch (error) {
          this.setRenderedFooter({ lines: [`footer error: ${getErrorMessage(error)}`] });
        }
      },
      setHeader: (factory?: (tui: unknown, thm: unknown) => unknown) => {
        this.extensionHeader?.component.dispose?.();
        this.extensionHeader = undefined;

        if (!factory) {
          this.setRenderedHeader(undefined);
          return;
        }

        try {
          const instance = factory(extensionTui, theme);
          if (!isRenderableComponent(instance)) {
            this.setRenderedHeader({ lines: ["header error: factory returned invalid component"] });
            return;
          }

          this.extensionHeader = { component: instance };
          this.renderExtensionHeader(true);
        } catch (error) {
          this.setRenderedHeader({ lines: [`header error: ${getErrorMessage(error)}`] });
        }
      },
      setTitle: (title: string) => {
        this.extensionTitle = title;
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

  replaceSession(session: any, sessionManager: any, globalMutationTracker?: GlobalMutationTracker) {
    const previousSession = this.session;
    this.globalMutationTracker?.release();
    this.unsubscribeFromSession();
    this.cancelPendingUiRequests();

    this.session = session;
    this.sessionManager = sessionManager;
    this.globalMutationTracker = globalMutationTracker;
    this.pendingMessageIds.clear();
    this.pendingMessageSequence = 0;
    this.toolExecutions.clear();
    this.contextUsage = undefined;
    this.cachedGitBranch = undefined;

    this.subscribeToSession(session);
    this.renderDynamicExtensionUi();
    void this.refreshAvailableProviderCount();
    previousSession.dispose();
  }

  dispose() {
    this.globalMutationTracker?.release();
    this.globalMutationTracker = undefined;
    if (this.externalReloadTimeout) {
      clearTimeout(this.externalReloadTimeout);
      this.externalReloadTimeout = undefined;
    }
    if (this.extensionBranchPollInterval) {
      clearInterval(this.extensionBranchPollInterval);
      this.extensionBranchPollInterval = undefined;
    }
    this.extensionHeader?.component.dispose?.();
    this.extensionFooter?.component.dispose?.();
    for (const widget of this.extensionWidgets.values()) {
      widget.component?.dispose?.();
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
