import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { createAgentSession } from "@earendil-works/pi-coding-agent";
import type {
  ApiExtensionNotification,
  ApiExtensionSurface,
  ApiExtensionUiRequest,
  ApiExtensionUiResponse,
  ApiExtensionWidget,
  SessionEvent,
} from "@pi-web-app/shared";

export type ExtensionUiSubscriber = (event: SessionEvent) => void;

type CreateAgentSessionResult = Awaited<ReturnType<typeof createAgentSession>>;
type AgentSession = CreateAgentSessionResult["session"];

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

const DEFAULT_EXTENSION_RENDER_COLUMNS = 100;
const MIN_EXTENSION_RENDER_COLUMNS = 40;
const MAX_EXTENSION_RENDER_COLUMNS = 240;
const GIT_BRANCH_POLL_INTERVAL_MS = 3_000;

export class ExtensionUiBridge {
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
  private notificationsSuppressed = false;

  constructor(
    private readonly publish: (event: SessionEvent) => void,
    private readonly getSession: () => AgentSession,
    private readonly getSessionCwd: () => string | undefined,
  ) {}

  setNotificationsSuppressed(suppressed: boolean) {
    this.notificationsSuppressed = suppressed;
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
    this.renderDynamicUi();
  }

  replayState(subscriber: ExtensionUiSubscriber) {
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

  resetAfterSessionReplace() {
    this.cachedGitBranch = undefined;
    this.renderDynamicUi();
    void this.refreshAvailableProviderCount();
  }

  cancelPendingUiRequests() {
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

  dispose() {
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
  }

  async refreshAvailableProviderCount() {
    const session = this.getSession();
    const getAvailable = session?.modelRegistry?.getAvailable;
    if (typeof getAvailable !== "function") {
      return;
    }

    try {
      const models = await getAvailable.call(session.modelRegistry);
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
      this.renderDynamicUi();
    } catch {
      // Ignore model registry refresh failures in web-ui bridge.
    }
  }

  renderDynamicUi() {
    this.renderExtensionHeader();
    this.renderExtensionFooter();
    for (const widget of this.extensionWidgets.values()) {
      if (widget.component) {
        this.renderExtensionWidget(widget.key);
      }
    }
  }

  createContext(options: { suppressNotifications?: boolean } = {}) {
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
        this.renderDynamicUi();
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
        if (this.notificationsSuppressed) {
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
}
