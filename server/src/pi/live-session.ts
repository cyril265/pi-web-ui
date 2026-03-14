import { randomUUID } from "node:crypto";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  ApiExtensionNotification,
  ApiExtensionUiRequest,
  ApiExtensionUiResponse,
  ApiToolExecution,
  SessionEvent,
} from "@pi-web-app/shared";
import { createSnapshot } from "./serialize.js";

export type SessionSubscriber = (event: SessionEvent) => void;

export class LiveSession {
  readonly subscribers = new Set<SessionSubscriber>();
  readonly toolExecutions = new Map<string, ApiToolExecution>();

  externallyDirty = false;
  lastInternalUpdateAt = Date.now();

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
  private readonly unsubscribeFromSession: () => void;

  constructor(
    readonly session: any,
    sessionManager: any,
  ) {
    this.sessionManager = sessionManager;
    this.unsubscribeFromSession = session.subscribe((event: any) => {
      this.handleSessionEvent(event);
    });
  }

  sessionManager: any;

  subscribe(subscriber: SessionSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber({ type: "snapshot", snapshot: this.getSnapshot() });
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  getSnapshot() {
    return createSnapshot({
      session: this.session,
      sessionName: this.getSessionName(),
      toolExecutions: this.toolExecutions,
      externallyDirty: this.externallyDirty,
    });
  }

  getSessionName(): string | undefined {
    const sessionManager = this.session?.sessionManager ?? this.sessionManager;
    const sessionName = sessionManager?.getSessionName?.();
    return typeof sessionName === "string" && sessionName.trim() ? sessionName : undefined;
  }

  publishSnapshot(markInternalUpdate = true) {
    if (markInternalUpdate) {
      this.lastInternalUpdateAt = Date.now();
    }
    this.publish({
      type: "snapshot",
      snapshot: this.getSnapshot(),
    });
  }

  markExternalChange() {
    this.externallyDirty = true;
    this.hasPendingExternalReload = true;
    if (this.externalReloadTimeout) {
      clearTimeout(this.externalReloadTimeout);
    }
    this.externalReloadTimeout = setTimeout(() => {
      this.externalReloadTimeout = undefined;
      void this.reloadExternalChanges();
    }, 150);
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
      setWidget: (key: string, content?: string[], options?: { placement?: "aboveEditor" | "belowEditor" }) => {
        this.publish({
          type: "set_widget",
          key,
          widget: content
            ? {
                key,
                lines: content,
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

  dispose() {
    if (this.externalReloadTimeout) {
      clearTimeout(this.externalReloadTimeout);
      this.externalReloadTimeout = undefined;
    }
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
    this.subscribers.clear();
    this.unsubscribeFromSession();
    this.session.dispose();
  }

  private async reloadExternalChanges() {
    if (this.isReloadingExternally) {
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
        this.externalReloadTimeout = setTimeout(() => {
          this.externalReloadTimeout = undefined;
          void this.reloadExternalChanges();
        }, 150);
      }
    }
  }

  private async syncSessionStateFromDisk() {
    const sessionFile = typeof this.session.sessionFile === "string" ? this.session.sessionFile : undefined;
    if (!sessionFile) {
      return;
    }

    const sessionManager = this.session?.sessionManager ?? this.sessionManager ?? SessionManager.open(sessionFile);
    if (!sessionManager?.setSessionFile || !sessionManager?.buildSessionContext) {
      this.sessionManager = SessionManager.open(sessionFile);
      return;
    }

    sessionManager.setSessionFile(sessionFile);
    this.sessionManager = sessionManager;

    this.session._steeringMessages = [];
    this.session._followUpMessages = [];
    this.session._pendingNextTurnMessages = [];

    const sessionContext = sessionManager.buildSessionContext();

    if (this.session?.agent) {
      this.session.agent.sessionId = sessionManager.getSessionId();
      this.session.agent.replaceMessages(sessionContext.messages ?? []);
    }

    await this.restoreModelFromSessionContext(sessionContext?.model);
    this.restoreThinkingLevelFromSessionContext(sessionContext?.thinkingLevel);
  }

  private async restoreModelFromSessionContext(sessionModel: {
    provider?: string;
    modelId?: string;
  } | undefined) {
    if (!sessionModel?.provider || !sessionModel?.modelId) {
      return;
    }

    const availableModels = await this.session?.modelRegistry?.getAvailable?.();
    if (!Array.isArray(availableModels)) {
      return;
    }

    const matchingModel = availableModels.find((model: any) =>
      model?.provider === sessionModel.provider && model?.id === sessionModel.modelId
    );

    if (matchingModel) {
      this.session.agent?.setModel?.(matchingModel);
    }
  }

  private restoreThinkingLevelFromSessionContext(thinkingLevel: unknown) {
    if (typeof thinkingLevel !== "string") {
      return;
    }

    const availableLevels = this.session?.getAvailableThinkingLevels?.();
    const effectiveThinkingLevel = Array.isArray(availableLevels) && availableLevels.length > 0
      ? availableLevels.includes(thinkingLevel)
        ? thinkingLevel
        : availableLevels[availableLevels.length - 1]
      : thinkingLevel;

    this.session.agent?.setThinkingLevel?.(effectiveThinkingLevel);
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

  private handleSessionEvent(event: any) {
    switch (event.type) {
      case "tool_execution_start": {
        const now = new Date().toISOString();
        this.toolExecutions.set(String(event.toolCallId), {
          toolCallId: String(event.toolCallId),
          toolName: String(event.toolName),
          status: "running",
          text: "",
          startedAt: now,
          updatedAt: now,
        });
        break;
      }
      case "tool_execution_update": {
        const current = this.toolExecutions.get(String(event.toolCallId));
        if (current) {
          current.text = stringifyToolOutput(event.partialResult);
          current.updatedAt = new Date().toISOString();
        }
        break;
      }
      case "tool_execution_end": {
        const current = this.toolExecutions.get(String(event.toolCallId));
        if (current) {
          current.status = event.isError ? "error" : "done";
          current.text = stringifyToolOutput(event.result);
          current.updatedAt = new Date().toISOString();
        }
        break;
      }
      default:
        break;
    }

    this.publishSnapshot();
  }
}

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
