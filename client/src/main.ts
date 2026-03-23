import { html, render, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import { BUILTIN_SLASH_COMMANDS } from "@pi-web-app/shared";
import type {
  ApiExtensionNotification,
  ApiExtensionStatusEntry,
  ApiExtensionUiRequest,
  ApiExtensionWidget,
  ApiForkMessage,
  ApiImageInput,
  ApiModelInfo,
  ApiSlashCommand,
  ApiSessionListItem,
  ApiSessionSnapshot,
  ApiTreeMessage,
  SessionEvent,
  ThinkingLevel,
} from "@pi-web-app/shared";
import "./app.css";

/* ─── Types ─── */

type ComposerMode = "prompt" | "steer" | "follow-up";

type PendingAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  preview: string | undefined;
  data: string;
};

type PendingComposerSubmission = {
  id: string;
  sessionId: string;
  matchSequence: number;
  snapshotMessageCount: number;
  message: ApiSessionSnapshot["messages"][number];
};

type ThemeMode = "light" | "dark" | "system";
type ColorTheme = "default" | "gruvbox" | "ghostty";
type ParsedToolCallMessage = {
  toolName: string;
  args: string;
  preview: string | undefined;
};
type AssistantMessagePart =
  | { type: "markdown"; text: string }
  | { type: "toolCall"; toolCall: ParsedToolCallMessage };
type LiveConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";
type ApiRequestOptions = {
  signal?: AbortSignal;
};
type SessionSelection = {
  token: number;
  signal: AbortSignal;
};

type AppState = {
  sessions: ApiSessionListItem[];
  sessionsScope: "current" | "all";
  sessionsSearch: string;
  activeSession: ApiSessionSnapshot | undefined;
  availableModels: ApiModelInfo[];
  recentModelKeys: string[];
  modelSearch: string;
  availableSlashCommands: ApiSlashCommand[];
  selectedSlashCommandIndex: number;
  composerText: string;
  composerMode: ComposerMode;
  attachments: PendingAttachment[];
  pendingComposerSubmissions: PendingComposerSubmission[];
  forkMessages: ApiForkMessage[];
  treeMessages: ApiTreeMessage[];
  pendingExtensionUi: ApiExtensionUiRequest | undefined;
  extensionUiValue: string;
  extensionNotifications: ApiExtensionNotification[];
  extensionStatuses: ApiExtensionStatusEntry[];
  extensionWidgets: ApiExtensionWidget[];
  pageTitle: string | undefined;
  renameText: string;
  isLoading: boolean;
  isSubmittingComposer: boolean;
  isLoadingForkMessages: boolean;
  isLoadingTreeMessages: boolean;
  isReopeningSession: boolean;
  showMenu: boolean;
  showModels: boolean;
  showActions: boolean;
  showTokenUsage: boolean;
  error: string | undefined;
  info: string | undefined;
  liveConnectionState: LiveConnectionState;
  switchingSessionId: string | undefined;
  sidebarOpen: boolean;
  themeMode: ThemeMode;
  colorTheme: ColorTheme;
  expandedGroups: Set<string>;
  expandedToolCards: Set<string>;
};

/* ─── State ─── */

const SESSIONS_PER_GROUP = 5;
const MOBILE_SIDEBAR_MEDIA_QUERY = "(max-width: 900px)";
const RECENT_MODELS_STORAGE_KEY = "recent-models";
const RECENT_MODELS_LIMIT = 8;
const MAX_VISIBLE_SLASH_COMMANDS = 8;
const sidebarMediaQuery = window.matchMedia(MOBILE_SIDEBAR_MEDIA_QUERY);

function loadRecentModelKeys() {
  return (localStorage.getItem(RECENT_MODELS_STORAGE_KEY) ?? "")
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

const state: AppState = {
  sessions: [],
  sessionsScope: "all",
  sessionsSearch: "",
  activeSession: undefined,
  availableModels: [],
  recentModelKeys: loadRecentModelKeys(),
  modelSearch: "",
  availableSlashCommands: [...BUILTIN_SLASH_COMMANDS],
  selectedSlashCommandIndex: 0,
  composerText: "",
  composerMode: "prompt",
  attachments: [],
  pendingComposerSubmissions: [],
  forkMessages: [],
  treeMessages: [],
  pendingExtensionUi: undefined,
  extensionUiValue: "",
  extensionNotifications: [],
  extensionStatuses: [],
  extensionWidgets: [],
  pageTitle: undefined,
  renameText: "",
  isLoading: true,
  isSubmittingComposer: false,
  isLoadingForkMessages: false,
  isLoadingTreeMessages: false,
  isReopeningSession: false,
  showMenu: false,
  showModels: false,
  showActions: false,
  showTokenUsage: (localStorage.getItem("showTokenUsage") ?? "true") === "true",
  error: undefined,
  info: undefined,
  liveConnectionState: "disconnected",
  switchingSessionId: undefined,
  sidebarOpen: !sidebarMediaQuery.matches,
  themeMode: (localStorage.getItem("theme") as ThemeMode) || "system",
  colorTheme: (localStorage.getItem("color-theme") as ColorTheme) || "ghostty",
  expandedGroups: new Set<string>(),
  expandedToolCards: new Set<string>(),
};

let currentEvents: EventSource | undefined;
let currentSessionSelection = 0;
let currentSessionSelectionController = new AbortController();
let eventReconnectTimeout: ReturnType<typeof setTimeout> | undefined;
let eventReconnectAttempts = 0;
let sessionsLoadRequestId = 0;
let slashCommandsLoadRequestId = 0;
const levels: ThinkingLevel[] = ["off", "low", "medium", "high"];
let messagesContainer: HTMLElement | null = null;
const EVENT_RECONNECT_BASE_DELAY_MS = 1_000;
const EVENT_RECONNECT_MAX_DELAY_MS = 10_000;
const assistantMessagePartsCache = new Map<string, AssistantMessagePart[]>();
const markdownHtmlCache = new Map<string, string>();

marked.setOptions({ breaks: true, gfm: true });

/* ─── API / state logic ─── */

async function bootstrap() {
  applyTheme();
  try {
    await Promise.all([loadSessions(), loadModels()]);
    const firstSession = state.sessions[0];
    if (firstSession?.live) {
      try {
        await attachToLiveSession(firstSession.id);
      } catch (error) {
        if (isAbortError(error) || !firstSession.sessionFile || !isSessionNotFoundError(error)) {
          throw error;
        }
        await openSession(firstSession.sessionFile);
      }
    } else if (firstSession?.sessionFile) {
      await openSession(firstSession.sessionFile);
    } else {
      await createSession();
    }
  } catch (error) {
    if (!isAbortError(error)) {
      setError(getErrorMessage(error));
    }
  } finally {
    state.isLoading = false;
    renderApp();
  }
}

async function loadSessions(scope = state.sessionsScope) {
  state.sessionsScope = scope;
  const requestId = ++sessionsLoadRequestId;
  const response = await apiGet<{ sessions: ApiSessionListItem[] }>(`/api/sessions?scope=${scope}`);
  if (requestId !== sessionsLoadRequestId || scope !== state.sessionsScope) {
    return;
  }
  state.sessions = response.sessions;
  renderApp();
}

async function loadModels() {
  const response = await apiGet<{ models: ApiModelInfo[] }>("/api/models");
  state.availableModels = response.models;
}

async function loadSlashCommands(sessionId: string) {
  const requestId = ++slashCommandsLoadRequestId;
  const response = await apiGet<{ commands: ApiSlashCommand[] }>(`/api/sessions/${sessionId}/commands`);
  if (requestId !== slashCommandsLoadRequestId || state.activeSession?.sessionId !== sessionId) {
    return;
  }
  state.availableSlashCommands = response.commands;
  const visibleSlashCommands = getVisibleSlashCommands();
  if (visibleSlashCommands.length === 0) {
    state.selectedSlashCommandIndex = 0;
  } else if (state.selectedSlashCommandIndex >= visibleSlashCommands.length) {
    state.selectedSlashCommandIndex = visibleSlashCommands.length - 1;
  }
  renderApp();
}

function refreshSessionsInBackground(scope = state.sessionsScope) {
  void loadSessions(scope).catch((error) => {
    state.error = getErrorMessage(error);
    renderApp();
  });
}

function refreshSlashCommandsInBackground(sessionId = state.activeSession?.sessionId) {
  if (!sessionId) {
    state.availableSlashCommands = [...BUILTIN_SLASH_COMMANDS];
    state.selectedSlashCommandIndex = 0;
    return;
  }

  void loadSlashCommands(sessionId).catch((error) => {
    if (state.activeSession?.sessionId !== sessionId) {
      return;
    }
    state.error = getErrorMessage(error);
    renderApp();
  });
}

function disconnectCurrentEvents() {
  clearEventReconnectTimer();
  const previousEvents = currentEvents;
  currentEvents = undefined;
  previousEvents?.close();
}

function beginSessionSelection(): SessionSelection {
  currentSessionSelection += 1;
  currentSessionSelectionController.abort();
  currentSessionSelectionController = new AbortController();
  disconnectCurrentEvents();
  if (state.activeSession) {
    state.liveConnectionState = "connecting";
  }
  return {
    token: currentSessionSelection,
    signal: currentSessionSelectionController.signal,
  };
}

function isCurrentSessionSelection(token: number) {
  return token === currentSessionSelection;
}

async function loadAndOpenSnapshot(
  loadSnapshot: (signal: AbortSignal) => Promise<ApiSessionSnapshot>,
  options: { refreshSessions?: boolean } = {},
) {
  const previousSession = state.activeSession;
  const selection = beginSessionSelection();
  try {
    const snapshot = await loadSnapshot(selection.signal);
    const opened = openSnapshot(snapshot, selection.token);
    if (opened && options.refreshSessions) {
      refreshSessionsInBackground();
    }
    return opened;
  } catch (error) {
    if (
      !isAbortError(error) &&
      previousSession &&
      isCurrentSessionSelection(selection.token) &&
      state.activeSession?.sessionId === previousSession.sessionId
    ) {
      state.liveConnectionState = "connecting";
      connectEvents(previousSession.sessionId);
      renderApp();
    }
    throw error;
  }
}

async function createSession() {
  return await loadAndOpenSnapshot(
    async (signal) => {
      const response = await apiPost<{ snapshot: ApiSessionSnapshot }>("/api/sessions", {}, { signal });
      return response.snapshot;
    },
    { refreshSessions: true },
  );
}

async function handleCreateSession() {
  await createSession();
  closeSidebarIfMobile();
}

async function openSession(sessionFile: string) {
  return await loadAndOpenSnapshot(
    async (signal) => {
      const response = await apiPost<{ snapshot: ApiSessionSnapshot }>(
        "/api/sessions/open",
        { path: sessionFile },
        { signal },
      );
      return response.snapshot;
    },
    { refreshSessions: true },
  );
}

async function attachToLiveSession(sessionId: string) {
  return await loadAndOpenSnapshot(async (signal) => {
    const response = await apiGet<{ snapshot: ApiSessionSnapshot }>(`/api/sessions/${sessionId}`, { signal });
    return response.snapshot;
  });
}

async function sendComposer() {
  if (!state.activeSession) return;
  if (state.isSubmittingComposer) return;
  if (!state.composerText.trim() && state.attachments.length === 0) return;

  const activeSession = state.activeSession;
  const sessionId = activeSession.sessionId;
  const composerMode = state.composerMode;
  const submittedText = state.composerText;
  const submittedAttachments = [...state.attachments];
  const parsedSlashCommand = parseSlashCommandInput(submittedText);
  const slashCommand = parsedSlashCommand ? getSlashCommandByName(parsedSlashCommand.name) : undefined;

  if (slashCommand?.source === "extension" && composerMode !== "prompt") {
    state.error = `/${slashCommand.name} must be sent in prompt mode.`;
    renderApp();
    return;
  }

  if (slashCommand?.source === "builtin") {
    if (submittedAttachments.length > 0) {
      state.error = `/${slashCommand.name} does not accept image attachments in Pi Web.`;
      renderApp();
      return;
    }

    state.isSubmittingComposer = true;
    state.error = undefined;
    state.info = undefined;
    renderApp();

    try {
      await executeBuiltinSlashCommand(slashCommand.name, parsedSlashCommand?.args ?? "");
      state.composerText = "";
      state.attachments = [];
    } catch (error) {
      state.error = getErrorMessage(error);
    } finally {
      state.isSubmittingComposer = false;
      renderApp();
    }
    return;
  }

  const shouldCreateOptimisticMessage = !slashCommand;
  let pendingSubmission: PendingComposerSubmission | undefined;

  if (shouldCreateOptimisticMessage) {
    const optimisticMessage = createOptimisticComposerMessage(
      submittedText,
      composerMode === "prompt" ? submittedAttachments : [],
    );
    const matchingPendingCount = state.pendingComposerSubmissions.filter((submission) =>
      submission.sessionId === sessionId &&
      submission.message.role === optimisticMessage.role &&
      submission.message.text === optimisticMessage.text,
    ).length;
    pendingSubmission = {
      id: optimisticMessage.id,
      sessionId,
      matchSequence: matchingPendingCount + 1,
      snapshotMessageCount: activeSession.messages.length,
      message: optimisticMessage,
    };
  }

  state.isSubmittingComposer = true;
  state.composerText = "";
  state.attachments = [];
  state.error = undefined;
  state.info = undefined;
  if (pendingSubmission) {
    state.pendingComposerSubmissions = [...state.pendingComposerSubmissions, pendingSubmission];
  }
  renderApp();
  if (pendingSubmission) {
    scrollToBottom();
    await waitForNextPaint();
  }

  const body = {
    message: submittedText,
    images: submittedAttachments.map<ApiImageInput>((a) => ({
      fileName: a.fileName,
      mimeType: a.mimeType,
      data: a.data,
    })),
  };

  try {
    if (composerMode === "prompt") {
      await apiPost(`/api/sessions/${sessionId}/prompt`, body);
    } else if (composerMode === "steer") {
      await apiPost(`/api/sessions/${sessionId}/steer`, { message: submittedText });
    } else {
      await apiPost(`/api/sessions/${sessionId}/follow-up`, { message: submittedText });
    }
  } catch (error) {
    if (pendingSubmission) {
      state.pendingComposerSubmissions = state.pendingComposerSubmissions
        .filter((submission) => submission.id !== pendingSubmission?.id);
    }
    state.composerText = submittedText;
    state.attachments = submittedAttachments;
    state.error = getErrorMessage(error);
    renderApp();
  } finally {
    state.isSubmittingComposer = false;
    renderApp();
  }
}

async function abortRun() {
  if (!state.activeSession) return;
  await apiPost(`/api/sessions/${state.activeSession.sessionId}/abort`, {});
}

async function cycleModel() {
  if (!state.activeSession) return;
  await apiPost(`/api/sessions/${state.activeSession.sessionId}/model/cycle`, {});
  state.showModels = false;
  state.modelSearch = "";
}

function getModelKey(provider: string, modelId: string) {
  return `${provider}/${modelId}`;
}

function persistRecentModels() {
  localStorage.setItem(RECENT_MODELS_STORAGE_KEY, state.recentModelKeys.join("\n"));
}

function rememberRecentModel(provider: string, modelId: string) {
  const modelKey = getModelKey(provider, modelId);
  state.recentModelKeys = [modelKey, ...state.recentModelKeys.filter((value) => value !== modelKey)]
    .slice(0, RECENT_MODELS_LIMIT);
  persistRecentModels();
}

function openModelsDialog() {
  state.showModels = true;
  state.modelSearch = "";
  renderApp();
}

async function setModel(provider: string, modelId: string) {
  if (!state.activeSession) return;
  await apiPost(`/api/sessions/${state.activeSession.sessionId}/model`, { provider, modelId });
  rememberRecentModel(provider, modelId);
  state.showModels = false;
  state.modelSearch = "";
}

async function setThinkingLevel(level: ThinkingLevel) {
  if (!state.activeSession) return;
  await apiPost(`/api/sessions/${state.activeSession.sessionId}/thinking-level`, { thinkingLevel: level });
}

async function openActions() {
  if (!state.activeSession) return;
  const sessionId = state.activeSession.sessionId;
  state.showActions = true;
  state.showMenu = false;
  state.renameText = state.activeSession.title;
  state.forkMessages = [];
  state.treeMessages = [];
  state.isLoadingForkMessages = true;
  state.isLoadingTreeMessages = true;
  renderApp();

  try {
    const [forkResponse, treeResponse] = await Promise.all([
      apiGet<{ messages: ApiForkMessage[] }>(`/api/sessions/${sessionId}/fork-messages`),
      apiGet<{ messages: ApiTreeMessage[] }>(`/api/sessions/${sessionId}/tree-messages`),
    ]);
    if (state.activeSession?.sessionId !== sessionId) return;
    state.forkMessages = forkResponse.messages;
    state.treeMessages = treeResponse.messages;
  } catch (error) {
    if (state.activeSession?.sessionId === sessionId) {
      state.error = getErrorMessage(error);
    }
  } finally {
    if (state.activeSession?.sessionId === sessionId) {
      state.isLoadingForkMessages = false;
      state.isLoadingTreeMessages = false;
      renderApp();
    }
  }
}

async function renameSession() {
  if (!state.activeSession) return;
  const sessionId = state.activeSession.sessionId;
  const name = state.renameText.trim();
  if (!name) return;
  const response = await apiPost<{ snapshot: ApiSessionSnapshot }>(
    `/api/sessions/${sessionId}/rename`,
    { name },
  );
  if (state.activeSession?.sessionId !== sessionId) {
    refreshSessionsInBackground();
    return;
  }
  openSnapshot(response.snapshot);
  refreshSessionsInBackground();
  state.info = "Session renamed.";
  renderApp();
}

async function reopenActiveSession() {
  if (!state.activeSession || state.isReopeningSession) return;
  const sessionId = state.activeSession.sessionId;
  state.isReopeningSession = true;
  renderApp();
  try {
    const response = await apiPost<{ snapshot: ApiSessionSnapshot }>(
      `/api/sessions/${sessionId}/reopen`,
      {},
    );
    if (state.activeSession?.sessionId !== sessionId) {
      refreshSessionsInBackground();
      return;
    }
    openSnapshot(response.snapshot);
    refreshSessionsInBackground();
    state.info = "Session reloaded from disk.";
  } catch (error) {
    if (state.activeSession?.sessionId === sessionId) {
      state.error = getErrorMessage(error);
    }
  } finally {
    state.isReopeningSession = false;
    renderApp();
  }
}

async function forkFromEntry(entryId: string) {
  if (!state.activeSession) return;
  const sessionId = state.activeSession.sessionId;
  const response = await apiPost<{ cancelled: boolean; selectedText: string; snapshot: ApiSessionSnapshot }>(
    `/api/sessions/${sessionId}/fork`,
    { entryId },
  );
  if (response.cancelled) return;
  if (state.activeSession?.sessionId !== sessionId) {
    refreshSessionsInBackground();
    return;
  }
  state.composerText = response.selectedText;
  state.showActions = false;
  openSnapshot(response.snapshot);
  refreshSessionsInBackground();
  state.info = "Fork created. The selected prompt was copied into the composer.";
  renderApp();
}

async function navigateTree(entryId: string) {
  if (!state.activeSession) return;
  const sessionId = state.activeSession.sessionId;
  const response = await apiPost<{ cancelled: boolean; editorText?: string; snapshot: ApiSessionSnapshot }>(
    `/api/sessions/${sessionId}/tree`,
    { entryId },
  );
  if (response.cancelled) return;
  if (state.activeSession?.sessionId !== sessionId) {
    refreshSessionsInBackground();
    return;
  }
  state.composerText = response.editorText ?? "";
  state.showActions = false;
  openSnapshot(response.snapshot);
  refreshSessionsInBackground();
  state.info = response.editorText
    ? "Tree position changed. The selected prompt was copied into the composer."
    : "Tree position changed.";
  renderApp();
}

async function handleFiles(files: FileList | null) {
  if (!files?.length) return;
  const { loadAttachment } = await import("@mariozechner/pi-web-ui");
  const loaded = await Promise.all([...files].map((file) => loadAttachment(file)));
  const images = loaded.filter((a) => a.type === "image");
  const ignoredCount = loaded.length - images.length;
  state.attachments = [
    ...state.attachments,
    ...images.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      preview: a.preview,
      data: a.content,
    })),
  ];
  if (ignoredCount > 0) {
    state.info = `${ignoredCount} non-image attachment(s) were skipped.`;
  }
  renderApp();
}

function clearRenderedMessageCaches() {
  assistantMessagePartsCache.clear();
  markdownHtmlCache.clear();
}

function getSessionPreviewFromSnapshot(snapshot: ApiSessionSnapshot) {
  const firstUserMessage = snapshot.messages.find((message) =>
    message.role === "user" || message.role === "user-with-attachments",
  );
  return firstUserMessage?.text ?? "";
}

function getSnapshotLastModified(snapshot: ApiSessionSnapshot, existing: ApiSessionListItem | undefined) {
  const timestamps = [
    snapshot.toolExecutions.at(-1)?.updatedAt,
    [...snapshot.messages].reverse().find((message) => message.timestamp)?.timestamp,
    existing?.lastModified,
    new Date().toISOString(),
  ].filter((value): value is string => Boolean(value));

  return timestamps.sort().at(-1);
}

function sortSessionListByLastModified(sessions: ApiSessionListItem[]) {
  return [...sessions].sort((left, right) => (right.lastModified ?? "").localeCompare(left.lastModified ?? ""));
}

function syncSessionListItem(snapshot: ApiSessionSnapshot) {
  const existing = state.sessions.find((session) =>
    session.id === snapshot.sessionId || (snapshot.sessionFile && session.sessionFile === snapshot.sessionFile),
  );
  const nextSession: ApiSessionListItem = {
    id: snapshot.sessionId,
    sessionFile: snapshot.sessionFile ?? existing?.sessionFile,
    cwd: existing?.cwd,
    isInCurrentWorkspace: existing?.isInCurrentWorkspace ?? true,
    title: snapshot.title,
    preview: getSessionPreviewFromSnapshot(snapshot),
    lastModified: getSnapshotLastModified(snapshot, existing),
    messageCount: snapshot.messages.length,
    modelId: snapshot.model?.id,
    thinkingLevel: snapshot.thinkingLevel,
    status: snapshot.status,
    live: true,
    externallyDirty: snapshot.externallyDirty,
  };
  const remainingSessions = state.sessions.filter((session) =>
    session.id !== snapshot.sessionId && (!snapshot.sessionFile || session.sessionFile !== snapshot.sessionFile),
  );
  state.sessions = sortSessionListByLastModified([nextSession, ...remainingSessions]);
}

function applySnapshot(snapshot: ApiSessionSnapshot, options: { resetSessionUi?: boolean } = {}) {
  const previousSessionId = state.activeSession?.sessionId;
  reconcilePendingComposerSubmissions(snapshot);
  state.activeSession = snapshot;
  const sessionChanged = previousSessionId !== snapshot.sessionId;
  if (sessionChanged) {
    state.expandedToolCards = new Set<string>();
    state.availableSlashCommands = [...BUILTIN_SLASH_COMMANDS];
    state.selectedSlashCommandIndex = 0;
    clearRenderedMessageCaches();
  }
  state.renameText = snapshot.title;
  if (options.resetSessionUi) {
    state.pendingExtensionUi = undefined;
    state.extensionUiValue = "";
    state.extensionStatuses = [];
    state.extensionWidgets = [];
  }
  state.pageTitle = snapshot.title;
  document.title = state.pageTitle;
  syncSessionListItem(snapshot);
  if (options.resetSessionUi) {
    state.error = undefined;
    state.isLoading = false;
    state.switchingSessionId = undefined;
  }
  return sessionChanged;
}

function openSnapshot(snapshot: ApiSessionSnapshot, selectionToken?: number) {
  if (selectionToken !== undefined && !isCurrentSessionSelection(selectionToken)) {
    return false;
  }
  applySnapshot(snapshot, { resetSessionUi: true });
  refreshSlashCommandsInBackground(snapshot.sessionId);
  state.liveConnectionState = "connecting";
  connectEvents(snapshot.sessionId);
  renderApp();
  scrollToBottom();
  return true;
}

function connectEvents(sessionId: string) {
  disconnectCurrentEvents();
  const events = new EventSource(`/api/sessions/${sessionId}/events`);
  currentEvents = events;

  events.onopen = () => {
    if (currentEvents !== events || state.activeSession?.sessionId !== sessionId) return;
    eventReconnectAttempts = 0;
    state.liveConnectionState = "connected";
    renderApp();
  };

  events.onmessage = (messageEvent) => {
    if (currentEvents !== events || state.activeSession?.sessionId !== sessionId) return;
    const event = JSON.parse(messageEvent.data) as SessionEvent;
    if (event.type === "snapshot") {
      const sessionChanged = applySnapshot(event.snapshot);
      if (sessionChanged) {
        state.liveConnectionState = "connecting";
        connectEvents(event.snapshot.sessionId);
        refreshSessionsInBackground();
        refreshSlashCommandsInBackground(event.snapshot.sessionId);
      }
    }
    if (event.type === "error") state.error = event.message;
    if (event.type === "info") state.info = event.message;
    if (event.type === "extension_ui_request") {
      state.pendingExtensionUi = event.request;
      state.extensionUiValue = event.request.prefill ?? "";
    }
    if (event.type === "extension_notify") pushExtensionNotification(event.notification);
    if (event.type === "set_editor_text") state.composerText = event.text;
    if (event.type === "set_status") setExtensionStatus(event.key, event.text);
    if (event.type === "set_widget") setExtensionWidget(event.key, event.widget);
    if (event.type === "set_title") {
      state.pageTitle = event.title;
      document.title = event.title;
    }
    renderApp();
    scrollToBottom();
  };

  events.onerror = () => {
    if (currentEvents !== events || state.activeSession?.sessionId !== sessionId) return;
    events.close();
    currentEvents = undefined;
    state.liveConnectionState = "reconnecting";
    renderApp();
    scheduleReconnect(sessionId);
  };
}

function setError(message: string) {
  state.error = message;
  renderApp();
}

function pushExtensionNotification(notification: ApiExtensionNotification) {
  state.extensionNotifications = [notification, ...state.extensionNotifications].slice(0, 4);
  setTimeout(() => {
    state.extensionNotifications = state.extensionNotifications.filter((e) => e.id !== notification.id);
    renderApp();
  }, 6_000).unref?.();
}

function setExtensionStatus(key: string, text: string | undefined) {
  state.extensionStatuses = text
    ? [{ key, text }, ...state.extensionStatuses.filter((e) => e.key !== key)]
    : state.extensionStatuses.filter((e) => e.key !== key);
}

function setExtensionWidget(key: string, widget: ApiExtensionWidget | undefined) {
  state.extensionWidgets = widget
    ? [widget, ...state.extensionWidgets.filter((e) => e.key !== key)]
    : state.extensionWidgets.filter((e) => e.key !== key);
}

async function submitExtensionUiResponse(response: {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}) {
  if (!state.activeSession || !state.pendingExtensionUi) return;
  const requestId = state.pendingExtensionUi.id;
  state.pendingExtensionUi = undefined;
  renderApp();
  await apiPost(`/api/sessions/${state.activeSession.sessionId}/ui-response`, {
    id: requestId,
    value: response.value,
    confirmed: response.confirmed,
    cancelled: response.cancelled,
  });
}

/* ─── Theme ─── */

function applyTheme() {
  const root = document.documentElement;
  root.classList.remove("dark");
  const isDark =
    state.themeMode === "dark" ||
    (state.themeMode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  if (isDark) root.classList.add("dark");

  if (state.colorTheme !== "default") {
    root.setAttribute("data-color-theme", state.colorTheme);
  } else {
    root.removeAttribute("data-color-theme");
  }
}

function setThemeMode(mode: ThemeMode) {
  state.themeMode = mode;
  localStorage.setItem("theme", mode);
  applyTheme();
  renderApp();
}

function setColorTheme(theme: ColorTheme) {
  state.colorTheme = theme;
  localStorage.setItem("color-theme", theme);
  applyTheme();
  renderApp();
}

function toggleTokenUsage() {
  state.showTokenUsage = !state.showTokenUsage;
  localStorage.setItem("showTokenUsage", String(state.showTokenUsage));
  renderApp();
}

/* ─── Helpers ─── */

function isMobileSidebarLayout() {
  return sidebarMediaQuery.matches;
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  state.showMenu = false;
  renderApp();
}

function closeSidebar() {
  if (!state.sidebarOpen) return;
  state.sidebarOpen = false;
  renderApp();
}

function closeSidebarIfMobile() {
  if (!isMobileSidebarLayout()) return;
  closeSidebar();
}

function handleSidebarViewportChange(event: MediaQueryListEvent | MediaQueryList) {
  state.sidebarOpen = !event.matches;
  if (document.getElementById("app")) {
    renderApp();
  }
}

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function getComposerPlaceholder(mode: ComposerMode) {
  if (mode === "steer") return "Steer Pi\u2026";
  if (mode === "follow-up") return "Follow up\u2026";
  return "Type a message...";
}

function matchesSearchTokens(text: string, query: string) {
  const haystack = text.toLowerCase();
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  return tokens.every((token) => haystack.includes(token));
}

function getVisibleModels() {
  const query = state.modelSearch.trim();
  const currentModelKey = state.activeSession?.model
    ? getModelKey(state.activeSession.model.provider, state.activeSession.model.id)
    : undefined;

  return [...state.availableModels]
    .filter((model) => {
      if (!query) return true;
      return matchesSearchTokens(`${model.name} ${model.provider} ${model.id}`, query);
    })
    .sort((left, right) => {
      const leftKey = getModelKey(left.provider, left.id);
      const rightKey = getModelKey(right.provider, right.id);
      const leftRecentIndex = state.recentModelKeys.indexOf(leftKey);
      const rightRecentIndex = state.recentModelKeys.indexOf(rightKey);
      const normalizedLeftRecentIndex = leftRecentIndex === -1 ? Number.MAX_SAFE_INTEGER : leftRecentIndex;
      const normalizedRightRecentIndex = rightRecentIndex === -1 ? Number.MAX_SAFE_INTEGER : rightRecentIndex;
      if (normalizedLeftRecentIndex !== normalizedRightRecentIndex) {
        return normalizedLeftRecentIndex - normalizedRightRecentIndex;
      }

      const leftIsCurrent = leftKey === currentModelKey;
      const rightIsCurrent = rightKey === currentModelKey;
      if (leftIsCurrent !== rightIsCurrent) {
        return leftIsCurrent ? -1 : 1;
      }

      const nameComparison = left.name.localeCompare(right.name);
      if (nameComparison !== 0) {
        return nameComparison;
      }

      return leftKey.localeCompare(rightKey);
    });
}

function getSlashCommandCatalog() {
  const commands = state.availableSlashCommands.length > 0
    ? state.availableSlashCommands
    : [...BUILTIN_SLASH_COMMANDS];
  const commandsByName = new Map<string, ApiSlashCommand>();
  for (const command of commands) {
    if (!commandsByName.has(command.name)) {
      commandsByName.set(command.name, command);
    }
  }
  return [...commandsByName.values()];
}

function getSlashCommandByName(name: string) {
  return getSlashCommandCatalog().find((command) => command.name.toLowerCase() === name.toLowerCase());
}

function getSlashCommandQuery(text: string) {
  const match = text.match(/^\/([^\s\n]*)$/);
  return match?.[1]?.toLowerCase();
}

function parseSlashCommandInput(text: string) {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return undefined;
  }

  return {
    name: match[1]?.toLowerCase() ?? "",
    args: match[2]?.trim() ?? "",
  };
}

function getVisibleSlashCommands() {
  const query = getSlashCommandQuery(state.composerText);
  if (query === undefined) {
    return [];
  }

  return getSlashCommandCatalog()
    .filter((command) => {
      if (!query) {
        return true;
      }

      return matchesSearchTokens(`${command.name} ${command.description ?? ""}`, query);
    })
    .slice(0, MAX_VISIBLE_SLASH_COMMANDS);
}

function getSelectedSlashCommand() {
  const visibleSlashCommands = getVisibleSlashCommands();
  if (visibleSlashCommands.length === 0) {
    return undefined;
  }

  const selectedIndex = Math.min(state.selectedSlashCommandIndex, visibleSlashCommands.length - 1);
  return visibleSlashCommands[Math.max(0, selectedIndex)];
}

function focusComposerInput() {
  requestAnimationFrame(() => {
    const composer = document.querySelector(".pp-composer-input");
    if (composer instanceof HTMLTextAreaElement) {
      composer.focus();
      const position = composer.value.length;
      composer.setSelectionRange(position, position);
    }
  });
}

function applySlashCommandSelection(command: ApiSlashCommand) {
  state.composerText = `/${command.name} `;
  state.selectedSlashCommandIndex = 0;
  renderApp();
  focusComposerInput();
}

function moveSelectedSlashCommand(delta: number) {
  const visibleSlashCommands = getVisibleSlashCommands();
  if (visibleSlashCommands.length === 0) {
    return;
  }

  state.selectedSlashCommandIndex =
    (state.selectedSlashCommandIndex + delta + visibleSlashCommands.length) % visibleSlashCommands.length;
  renderApp();
}

function getSlashCommandSourceLabel(command: ApiSlashCommand) {
  if (command.source === "builtin") return "Built-in";
  if (command.source === "prompt") return command.location ? `Prompt · ${command.location}` : "Prompt";
  if (command.source === "skill") return command.location ? `Skill · ${command.location}` : "Skill";
  return "Extension";
}

function isSlashCommandSupportedInWeb(command: ApiSlashCommand) {
  if (command.source !== "builtin") {
    return true;
  }

  return new Set([
    "compact",
    "copy",
    "fork",
    "model",
    "name",
    "new",
    "reload",
    "resume",
    "session",
    "settings",
    "tree",
  ]).has(command.name);
}

async function executeBuiltinSlashCommand(commandName: string, args: string) {
  if (!state.activeSession) {
    return true;
  }

  const trimmedArgs = args.trim();
  const activeSession = state.activeSession;

  switch (commandName) {
    case "compact": {
      const response = await apiPost<{ snapshot: ApiSessionSnapshot }>(
        `/api/sessions/${activeSession.sessionId}/compact`,
        { instructions: trimmedArgs || undefined },
      );
      if (state.activeSession?.sessionId === activeSession.sessionId) {
        openSnapshot(response.snapshot);
        state.info = trimmedArgs ? "Session compacted with custom instructions." : "Session compacted.";
        renderApp();
      }
      return true;
    }
    case "copy": {
      const lastAssistantMessage = [...activeSession.messages].reverse().find((message) => message.role === "assistant");
      if (!lastAssistantMessage?.text.trim()) {
        state.error = "No assistant message is available to copy yet.";
        renderApp();
        return true;
      }
      await navigator.clipboard.writeText(lastAssistantMessage.text);
      state.info = "Copied the last assistant message.";
      renderApp();
      return true;
    }
    case "fork":
    case "tree":
      await openActions();
      return true;
    case "model":
      if (!trimmedArgs) {
        openModelsDialog();
        return true;
      }
      await setModelFromSlashCommand(trimmedArgs);
      return true;
    case "name":
      if (!trimmedArgs) {
        await openActions();
        return true;
      }
      state.renameText = trimmedArgs;
      await renameSession();
      return true;
    case "new":
      await handleCreateSession();
      return true;
    case "reload": {
      const response = await apiPost<{ snapshot: ApiSessionSnapshot }>(
        `/api/sessions/${activeSession.sessionId}/reload`,
        {},
      );
      if (state.activeSession?.sessionId === activeSession.sessionId) {
        openSnapshot(response.snapshot);
        refreshSessionsInBackground();
        refreshSlashCommandsInBackground(activeSession.sessionId);
        state.info = "Reloaded extensions, skills, prompts, and themes.";
        renderApp();
      }
      return true;
    }
    case "resume":
      state.sidebarOpen = true;
      state.showMenu = false;
      state.info = "Pick a session from the sidebar to resume it.";
      renderApp();
      focusComposerInput();
      return true;
    case "session": {
      const modelLabel = activeSession.model ? `${activeSession.model.provider}/${activeSession.model.id}` : "No model";
      state.info = `${activeSession.title} · ${activeSession.messages.length} msgs · ${modelLabel}`;
      renderApp();
      return true;
    }
    case "settings":
      state.showMenu = true;
      renderApp();
      return true;
    default:
      state.error = `/${commandName} is not available in Pi Web yet.`;
      renderApp();
      return true;
  }
}

async function setModelFromSlashCommand(query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  const matchingModel = [...state.availableModels]
    .sort((left, right) => {
      const leftIndex = state.recentModelKeys.indexOf(getModelKey(left.provider, left.id));
      const rightIndex = state.recentModelKeys.indexOf(getModelKey(right.provider, right.id));
      const normalizedLeftIndex = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
      const normalizedRightIndex = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
      if (normalizedLeftIndex !== normalizedRightIndex) {
        return normalizedLeftIndex - normalizedRightIndex;
      }
      return left.name.localeCompare(right.name);
    })
    .find((model) => {
      const modelKey = getModelKey(model.provider, model.id).toLowerCase();
      return (
        modelKey === normalizedQuery ||
        model.id.toLowerCase() === normalizedQuery ||
        model.name.toLowerCase() === normalizedQuery ||
        matchesSearchTokens(`${model.name} ${model.provider} ${model.id}`, normalizedQuery)
      );
    });

  if (!matchingModel) {
    state.error = `No model matched "${query}".`;
    renderApp();
    return;
  }

  await setModel(matchingModel.provider, matchingModel.id);
}

function createOptimisticComposerMessage(
  text: string,
  attachments: PendingAttachment[],
): ApiSessionSnapshot["messages"][number] {
  const attachmentLines = attachments.map((attachment) => `[image: ${attachment.mimeType}]`);
  const messageText = [text, ...attachmentLines]
    .filter((part) => part.trim().length > 0)
    .join("\n");

  return {
    id: `optimistic-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: attachments.length > 0 ? "user-with-attachments" : "user",
    text: messageText,
    timestamp: new Date().toISOString(),
  };
}

function isComposerSubmissionReflected(
  snapshot: ApiSessionSnapshot,
  submission: PendingComposerSubmission,
) {
  if (submission.sessionId !== snapshot.sessionId) return false;
  if (snapshot.messages.length < submission.snapshotMessageCount) return true;

  const reflectedMatchCount = snapshot.messages
    .slice(submission.snapshotMessageCount)
    .filter((message) => message.role === submission.message.role && message.text === submission.message.text)
    .length;

  return reflectedMatchCount >= submission.matchSequence;
}

function reconcilePendingComposerSubmissions(snapshot: ApiSessionSnapshot) {
  state.pendingComposerSubmissions = state.pendingComposerSubmissions.filter((submission) =>
    submission.sessionId !== snapshot.sessionId || !isComposerSubmissionReflected(snapshot, submission),
  );
}

function getRenderedMessages(snapshot: ApiSessionSnapshot) {
  const pendingMessages = state.pendingComposerSubmissions
    .filter((submission) => submission.sessionId === snapshot.sessionId)
    .filter((submission) => !isComposerSubmissionReflected(snapshot, submission))
    .map((submission) => submission.message);

  return pendingMessages.length > 0 ? [...snapshot.messages, ...pendingMessages] : snapshot.messages;
}

function clearEventReconnectTimer() {
  if (!eventReconnectTimeout) return;
  clearTimeout(eventReconnectTimeout);
  eventReconnectTimeout = undefined;
}

function scheduleReconnect(sessionId: string) {
  clearEventReconnectTimer();
  eventReconnectAttempts += 1;
  const delay = Math.min(
    EVENT_RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, eventReconnectAttempts - 1),
    EVENT_RECONNECT_MAX_DELAY_MS,
  );

  eventReconnectTimeout = setTimeout(() => {
    void reconnectActiveSession(sessionId);
  }, delay);
}

async function reconnectActiveSession(sessionId: string) {
  const activeSession = state.activeSession;
  if (!activeSession || activeSession.sessionId !== sessionId) return;

  try {
    await attachToLiveSession(sessionId);
    return;
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    if (!activeSession.sessionFile) {
      if (state.activeSession?.sessionId === sessionId) {
        scheduleReconnect(sessionId);
      }
      return;
    }
  }

  try {
    await openSession(activeSession.sessionFile!);
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    if (state.activeSession?.sessionFile === activeSession.sessionFile) {
      scheduleReconnect(sessionId);
    }
  }
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    const el = messagesContainer ?? document.querySelector(".pp-messages");
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function timeAgo(timestamp: string | undefined): string {
  if (!timestamp) return "";
  const normalized = /^\d+$/.test(timestamp) ? Number(timestamp) : timestamp;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function shortenCwd(cwd: string): string {
  const home = "/Users/kpovolotskyy";
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~/" + cwd.slice(home.length + 1).toUpperCase();
  return cwd;
}

function truncate(text: string, maxLength: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}\u2026`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatStructuredText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";

  const looksLikeJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));

  if (!looksLikeJson) return text;

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

function tryParseJson(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const looksLikeJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));

  if (!looksLikeJson) return undefined;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function highlightJson(prettyJson: string) {
  const escaped = escapeHtml(prettyJson);
  return escaped.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let className = "pp-json-number";
      if (match.startsWith("\"")) {
        className = match.endsWith(":") ? "pp-json-key" : "pp-json-string";
      } else if (match === "true" || match === "false") {
        className = "pp-json-boolean";
      } else if (match === "null") {
        className = "pp-json-null";
      }

      return `<span class="${className}">${match}</span>`;
    },
  );
}

function renderStructuredBlock(text: string) {
  const formatted = formatStructuredText(text).trim();
  const parsed = tryParseJson(formatted);

  if (parsed !== undefined) {
    const prettyJson = JSON.stringify(parsed, null, 2) ?? "";
    return html`<pre class="pp-json-view">${unsafeHTML(highlightJson(prettyJson))}</pre>`;
  }

  return html`<pre class="pp-tool-text">${formatted}</pre>`;
}

function getToolCardKey(...parts: string[]) {
  return [state.activeSession?.sessionId ?? "no-session", ...parts].join(":");
}

function handleToolCardToggle(cardKey: string, event: Event) {
  const details = event.currentTarget;
  if (!(details instanceof HTMLDetailsElement)) return;

  if (details.open) state.expandedToolCards.add(cardKey);
  else state.expandedToolCards.delete(cardKey);

  renderApp();
}

function summarizeToolCallPreview(argsText: string) {
  const trimmed = argsText.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const preferredPreviewKeys = ["command", "path", "prompt", "message", "query"];
      for (const key of preferredPreviewKeys) {
        const value = parsed[key];
        if (typeof value === "string" && value.trim()) {
          return truncate(value, 60);
        }
      }
    }
  } catch {
    // Fall back to a compact raw preview when tool arguments are partial JSON.
  }

  return truncate(trimmed.replace(/\s+/g, " "), 60);
}

function parseAssistantMessageParts(text: string): AssistantMessagePart[] {
  const cached = assistantMessagePartsCache.get(text);
  if (cached) return cached;

  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const parts: AssistantMessagePart[] = [];
  let markdownBuffer: string[] = [];
  let index = 0;

  const flushMarkdown = () => {
    const markdown = markdownBuffer.join("\n").trim();
    markdownBuffer = [];
    if (markdown) parts.push({ type: "markdown", text: markdown });
  };

  while (index < lines.length) {
    const toolCall = consumeToolCall(lines, index);
    if (!toolCall) {
      markdownBuffer.push(lines[index] ?? "");
      index += 1;
      continue;
    }

    flushMarkdown();
    parts.push({ type: "toolCall", toolCall: toolCall.message });
    index = toolCall.nextIndex;
  }

  flushMarkdown();
  const resolvedParts: AssistantMessagePart[] = parts.length ? parts : [{ type: "markdown", text }];
  assistantMessagePartsCache.set(text, resolvedParts);
  return resolvedParts;
}

function consumeToolCall(lines: string[], startIndex: number) {
  const match = lines[startIndex]?.trim().match(/^\[tool call:\s*([^\]]+)\]$/);
  if (!match) return undefined;

  const toolName = match[1]?.trim();
  if (!toolName) return undefined;

  let index = startIndex + 1;
  while (index < lines.length && lines[index]?.trim() === "") index += 1;

  if (index >= lines.length) {
    return {
      message: { toolName, args: "", preview: undefined },
      nextIndex: index,
    };
  }

  const jsonLines: string[] = [];
  for (let end = index; end < lines.length; end += 1) {
    if (lines[end]?.trim().match(/^\[tool call:\s*[^\]]+\]$/)) break;

    jsonLines.push(lines[end] ?? "");
    const candidate = jsonLines.join("\n").trim();
    if (!candidate) continue;

    if (
      ((candidate.startsWith("{") && candidate.endsWith("}")) ||
        (candidate.startsWith("[") && candidate.endsWith("]")))
    ) {
      try {
        JSON.parse(candidate);
        return {
          message: {
            toolName,
            args: candidate,
            preview: summarizeToolCallPreview(candidate),
          },
          nextIndex: end + 1,
        };
      } catch {
        // Keep accumulating until the JSON block is complete.
      }
    }
  }

  let endIndex = index;
  while (endIndex < lines.length && !lines[endIndex]?.trim().match(/^\[tool call:\s*[^\]]+\]$/)) {
    endIndex += 1;
  }

  const rawArgs = lines.slice(index, endIndex).join("\n").trim();
  return {
    message: {
      toolName,
      args: rawArgs,
      preview: summarizeToolCallPreview(rawArgs),
    },
    nextIndex: endIndex,
  };
}

function renderToolCallMessage(toolCall: ParsedToolCallMessage, cardKey: string, resultTexts: string[] = []) {
  const toolLabel = toolCall.preview ? `${toolCall.toolName} - ${toolCall.preview}` : toolCall.toolName;
  const statusLabel = resultTexts.length === 0 ? "call" : resultTexts.length === 1 ? "1 result" : `${resultTexts.length} results`;
  const isExpanded = state.expandedToolCards.has(cardKey);
  return html`
    <details class="pp-tool-card" ?open=${isExpanded} @toggle=${(event: Event) => handleToolCardToggle(cardKey, event)}>
      <summary class="pp-tool-summary">
        <span class="pp-tool-name">🛠 ${toolLabel}</span>
        <span class="pp-tool-status call">${statusLabel}</span>
      </summary>
      ${isExpanded
        ? html`
            <div class="pp-tool-content">
              <div class="pp-tool-section">
                <div class="pp-tool-section-label">Call</div>
                <div class="pp-tool-section-body">${renderStructuredBlock(toolCall.args || "No arguments")}</div>
              </div>
              ${resultTexts.map((resultText, index) => renderToolResultSection(resultText, index, resultTexts.length))}
            </div>
          `
        : nothing}
    </details>
  `;
}

function renderToolResultSection(resultText: string, index: number, total: number) {
  const label = total === 1 ? "Result" : `Result ${index + 1}`;
  return html`
    <div class="pp-tool-section pp-tool-section-result">
      <div class="pp-tool-section-label">${label}</div>
      <div class="pp-tool-section-body">${renderStructuredBlock(resultText)}</div>
    </div>
  `;
}

function renderMarkdown(text: string): ReturnType<typeof html> {
  const raw = markdownHtmlCache.get(text) ?? (() => {
    const rendered = marked.parse(text, { async: false }) as string;
    markdownHtmlCache.set(text, rendered);
    return rendered;
  })();
  return html`<div class="pp-markdown">${unsafeHTML(raw)}</div>`;
}

function copyToClipboard(text: string, button: HTMLButtonElement) {
  void navigator.clipboard.writeText(text).then(() => {
    const prev = button.textContent;
    button.textContent = "Copied!";
    setTimeout(() => { button.textContent = prev; }, 1500);
  });
}

function getVisibleSessions() {
  const query = state.sessionsSearch.trim().toLowerCase();
  if (!query) return state.sessions;
  return state.sessions.filter((s) => {
    const haystack = [s.title, s.preview, s.cwd, s.sessionFile]
      .filter((v): v is string => Boolean(v))
      .join("\n")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function groupSessionsByWorkspace(sessions: ApiSessionListItem[]) {
  const grouped = new Map<string, ApiSessionListItem[]>();
  for (const s of sessions) {
    const key = s.cwd ?? s.sessionFile ?? "Unknown";
    const cur = grouped.get(key);
    if (cur) cur.push(s);
    else grouped.set(key, [s]);
  }
  return [...grouped.entries()]
    .map(([cwd, list]) => ({
      cwd,
      sessions: list,
      isCurrentWorkspace: list.some((s) => s.isInCurrentWorkspace),
    }))
    .sort((a, b) => {
      if (a.isCurrentWorkspace !== b.isCurrentWorkspace) return a.isCurrentWorkspace ? -1 : 1;
      const aLatest = Math.max(...a.sessions.map(s => new Date(s.lastModified ?? 0).getTime()));
      const bLatest = Math.max(...b.sessions.map(s => new Date(s.lastModified ?? 0).getTime()));
      return bLatest - aLatest;
    });
}

async function handleSessionClick(session: ApiSessionListItem) {
  if (state.switchingSessionId === session.id) return;
  if (state.activeSession?.sessionId === session.id && session.live) {
    closeSidebarIfMobile();
    return;
  }

  state.switchingSessionId = session.id;
  state.isLoading = true;
  state.error = undefined;
  state.info = undefined;
  if (isMobileSidebarLayout()) {
    state.sidebarOpen = false;
  }
  renderApp();
  await waitForNextPaint();

  try {
    if (session.live) {
      try {
        await attachToLiveSession(session.id);
        return;
      } catch (error) {
        if (isAbortError(error) || !session.sessionFile || !isSessionNotFoundError(error)) {
          throw error;
        }
      }
    }
    if (session.sessionFile) {
      await openSession(session.sessionFile);
      return;
    }
  } catch (error) {
    if (!isAbortError(error)) {
      state.error = getErrorMessage(error);
    }
  } finally {
    const needsRender = state.switchingSessionId === session.id || state.isLoading;
    if (state.switchingSessionId === session.id) {
      state.switchingSessionId = undefined;
    }
    state.isLoading = false;
    if (needsRender) {
      renderApp();
    }
  }
}

function rotateThinkingLevel() {
  if (!state.activeSession) return;
  const currentIndex = levels.indexOf(state.activeSession.thinkingLevel);
  const next = levels[(currentIndex + 1 + levels.length) % levels.length] ?? "off";
  void setThinkingLevel(next);
}

function removeAttachment(id: string) {
  state.attachments = state.attachments.filter((a) => a.id !== id);
  renderApp();
}

/* ─── Render ─── */

function renderApp() {
  render(template(), document.getElementById("app")!);
  messagesContainer = document.querySelector(".pp-messages");
}

function renderConversation(messages: ApiSessionSnapshot["messages"]) {
  const grouped: ReturnType<typeof html>[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;

    if (message.role === "assistant") {
      const parts = parseAssistantMessageParts(message.text);
      const toolCallCount = parts.filter((part) => part.type === "toolCall").length;
      const groupedToolResults: string[][] = [];

      if (toolCallCount > 0) {
        const trailingToolResults: string[] = [];
        let nextIndex = index + 1;

        while (messages[nextIndex]?.role === "toolResult") {
          trailingToolResults.push(messages[nextIndex]!.text);
          nextIndex += 1;
        }

        for (let toolCallIndex = 0; toolCallIndex < toolCallCount; toolCallIndex += 1) {
          const assignedResults = trailingToolResults.length ? [trailingToolResults.shift()!] : [];
          if (toolCallIndex === toolCallCount - 1 && trailingToolResults.length) {
            assignedResults.push(...trailingToolResults.splice(0));
          }
          groupedToolResults.push(assignedResults);
        }

        if (groupedToolResults.some((results) => results.length > 0)) {
          index = nextIndex - 1;
        }
      }

      grouped.push(renderMessage(message, groupedToolResults));
      continue;
    }

    grouped.push(renderMessage(message));
  }

  return grouped;
}

const template = () => html`
  <div class="pp-shell">
    ${renderToasts()}

    <!-- Header -->
    <header class="pp-header">
      <div class="pp-header-left">
        <button
          class="pp-header-icon-btn"
          @click=${toggleSidebar}
          aria-label=${state.sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          aria-expanded=${String(state.sidebarOpen)}
        >\u2630</button>
        <span class="pp-header-title">Pi Web</span>
      </div>
      <div class="pp-header-right">
        <button
          class="pp-header-new-btn"
          @click=${handleCreateSession}
        >+ NEW</button>
        <button
          class="pp-header-icon-btn"
          @click=${() => { state.showMenu = !state.showMenu; renderApp(); }}
          aria-label="Menu"
        >⋯</button>
      </div>
    </header>

    ${state.showMenu ? renderMenu() : nothing}

    <!-- Body -->
    <div class="pp-body ${state.sidebarOpen ? "sidebar-open" : "sidebar-closed"} ${isMobileSidebarLayout() ? "sidebar-overlay" : "sidebar-docked"}">
      ${isMobileSidebarLayout() && state.sidebarOpen
        ? html`<button class="pp-sidebar-scrim" @click=${closeSidebar} aria-label="Close sidebar"></button>`
        : nothing}
      <!-- Sidebar -->
      <aside class="pp-sidebar ${isMobileSidebarLayout() ? "mobile" : "desktop"}" aria-hidden=${String(!state.sidebarOpen)}>
        <div class="pp-sidebar-search">
          <input
            type="text"
            placeholder="Search sessions\u2026"
            .value=${state.sessionsSearch}
            @input=${(e: Event) => { state.sessionsSearch = (e.target as HTMLInputElement).value; renderApp(); }}
          />
        </div>
        <div class="pp-sidebar-list">
          ${renderSidebarSessions()}
        </div>
      </aside>

      <!-- Main content -->
      <div class="pp-main">
        ${state.activeSession?.externallyDirty ? renderExternalBanner() : nothing}

        ${state.error ? html`<div class="pp-error" style="margin:0.75rem 1.5rem 0;">${state.error}</div>` : nothing}
        ${state.info ? html`<div class="pp-info" style="margin:0.75rem 1.5rem 0;">${state.info}</div>` : nothing}

        <div class="pp-messages">
          ${state.isLoading
            ? renderSkeleton()
            : state.activeSession && getRenderedMessages(state.activeSession).length
              ? renderConversation(getRenderedMessages(state.activeSession))
              : html`<div class="pp-empty">No messages yet. Start typing below.</div>`}

          ${state.activeSession?.toolExecutions.length
            ? state.activeSession.toolExecutions.map((tool) => renderToolCard(tool))
            : nothing}

          ${state.activeSession?.status === "streaming"
            ? html`<div style="margin-bottom:0.5rem;"><span class="pp-streaming-cursor"></span></div>`
            : nothing}
        </div>

        ${renderExtensionWidgets("aboveEditor")}

        <!-- Composer -->
        <div class="pp-composer-shell">
          ${renderSlashCommandPalette()}
          <div class="pp-composer">
            <label class="pp-composer-attach" title="Attach images">
              \ud83d\udcce
              <input
                type="file"
                accept="image/*"
                multiple
                @change=${(e: Event) => handleFiles((e.target as HTMLInputElement).files)}
              />
            </label>
            ${state.attachments.length ? renderAttachmentsRow() : nothing}
            <textarea
              class="pp-composer-input"
              rows="1"
              placeholder=${getComposerPlaceholder(state.composerMode)}
              .value=${live(state.composerText)}
              @input=${(e: Event) => {
                state.composerText = (e.target as HTMLTextAreaElement).value;
                state.selectedSlashCommandIndex = 0;
                renderApp();
              }}
              @keydown=${(e: KeyboardEvent) => {
                const selectedSlashCommand = getSelectedSlashCommand();
                if (selectedSlashCommand && e.key === "ArrowDown") {
                  e.preventDefault();
                  moveSelectedSlashCommand(1);
                  return;
                }
                if (selectedSlashCommand && e.key === "ArrowUp") {
                  e.preventDefault();
                  moveSelectedSlashCommand(-1);
                  return;
                }
                if (selectedSlashCommand && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))) {
                  e.preventDefault();
                  applySlashCommandSelection(selectedSlashCommand);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendComposer();
                }
              }}
            ></textarea>
            ${state.activeSession?.status === "streaming"
              ? html`<button
                  class="pp-composer-btn"
                  style="color:var(--pp-error-text);"
                  @click=${abortRun}
                  title="Stop"
                >\u25a0</button>`
              : html`<button
                  class="pp-composer-btn"
                  @click=${() => void sendComposer()}
                  title="Send"
                  ?disabled=${state.isSubmittingComposer}
                >\u27a4</button>`}
          </div>
        </div>

        ${renderExtensionWidgets("belowEditor")}

        <!-- Status bar -->
        <div class="pp-statusbar">
          ${state.activeSession
            ? html`<span class="pp-live-state ${state.liveConnectionState}">
                ${state.liveConnectionState === "connected"
                  ? "Live"
                  : state.liveConnectionState === "reconnecting"
                    ? "Reconnecting\u2026"
                    : "Connecting\u2026"}
              </span>`
            : nothing}
          ${state.extensionStatuses.map(
            (s) => html`<span style="font-size:0.6875rem;">${s.key}: ${s.text}</span>`,
          )}
          <button class="pp-statusbar-model" @click=${openModelsDialog}>
            ${state.activeSession?.model?.name ?? "No model"}
          </button>
          <span class="pp-statusbar-icon" title="Thinking: ${state.activeSession?.thinkingLevel ?? 'off'}">
            <button
              style="background:none;border:none;color:var(--pp-text-muted);cursor:pointer;font-size:0.75rem;"
              @click=${rotateThinkingLevel}
              title="Cycle thinking level"
            >\ud83d\udca1</button>
          </span>
          ${state.showTokenUsage && state.activeSession
            ? html`<span class="pp-statusbar-stats">
                ${getRenderedMessages(state.activeSession).length} msgs
              </span>`
            : nothing}
        </div>
      </div>
    </div>

    <!-- Dialogs -->
    ${state.showModels ? renderModelsDialog() : nothing}
    ${state.showActions ? renderActionsDialog() : nothing}
    ${state.pendingExtensionUi ? renderExtensionUiDialog(state.pendingExtensionUi) : nothing}
  </div>
`;

/* ─── Sidebar rendering ─── */

function renderSidebarSessions() {
  const visible = getVisibleSessions();
  if (visible.length === 0) {
    return html`<div style="padding:1rem 0.75rem;font-size:0.8125rem;color:var(--pp-text-muted);">No sessions match.</div>`;
  }
  const groups = groupSessionsByWorkspace(visible);
  return html`${groups.map((group) => renderSidebarGroup(group))}`;
}

function renderSidebarGroup(group: { cwd: string; sessions: ApiSessionListItem[]; isCurrentWorkspace: boolean }) {
  const label = shortenCwd(group.cwd);
  const isExpanded = state.expandedGroups.has(group.cwd);
  const limit = isExpanded ? group.sessions.length : SESSIONS_PER_GROUP;
  const visible = group.sessions.slice(0, limit);
  const remaining = group.sessions.length - limit;

  return html`
    <div class="pp-group-header">
      <span class="pp-group-label">${label}</span>
      <button class="pp-group-new" @click=${() => createSessionInWorkspace(group.cwd)}>+ NEW</button>
    </div>
    ${visible.map((s) => renderSidebarItem(s))}
    ${remaining > 0
      ? html`<button class="pp-show-more" @click=${() => { state.expandedGroups.add(group.cwd); renderApp(); }}>
          \u25be Show ${remaining} more\u2026
        </button>`
      : nothing}
  `;
}

async function createSessionInWorkspace(_cwd: string) {
  await handleCreateSession();
}

function renderSidebarItem(session: ApiSessionListItem) {
  const isSwitching = state.switchingSessionId === session.id;
  const isActive = state.switchingSessionId
    ? isSwitching
    : state.activeSession?.sessionId === session.id;
  return html`
    <button
      class="pp-session-item ${isActive ? "active" : ""} ${isSwitching ? "loading" : ""}"
      @click=${() => handleSessionClick(session)}
      ?disabled=${isSwitching}
      aria-busy=${String(isSwitching)}
    >
      <div class="pp-session-dot ${session.live || session.status === 'streaming' ? 'live' : 'idle'}"></div>
      <div class="pp-session-info">
        <div class="pp-session-title">${truncate(session.title, 60)}</div>
        <div class="pp-session-meta">
          <span class="pp-session-time">${isSwitching ? "Opening…" : timeAgo(session.lastModified)}</span>
          <span class="pp-session-badge">${session.messageCount}</span>
        </div>
      </div>
      <div class="pp-session-actions">
        <button
          class="pp-session-action-btn"
          @click=${(e: Event) => { e.stopPropagation(); openActions(); }}
          title="Actions"
        >\u2699</button>
      </div>
    </button>
  `;
}

/* ─── Message rendering ─── */

function renderMessage(message: ApiSessionSnapshot["messages"][number], groupedToolResults: string[][] = []) {
  if (message.role === "user" || message.role === "user-with-attachments") {
    return html`
      <div style="margin-bottom:0.75rem;">
        <div class="pp-msg-user">
          <div class="pp-msg-user-label">YOU</div>
          <div class="pp-msg-user-text">${message.text}</div>
        </div>
      </div>
    `;
  }

  if (message.role === "assistant") {
    const parts = parseAssistantMessageParts(message.text);
    let toolCallIndex = 0;
    return html`${parts.map((part, partIndex) => {
      if (part.type === "toolCall") {
        const currentToolCallIndex = toolCallIndex++;
        return renderToolCallMessage(
          part.toolCall,
          getToolCardKey("message", message.id, "tool-call", String(partIndex)),
          groupedToolResults[currentToolCallIndex] ?? [],
        );
      }

      return html`
        <div class="pp-msg-assistant">
          ${renderMarkdown(part.text)}
        </div>
      `;
    })}`;
  }

  if (message.role === "toolResult") {
    const cardKey = getToolCardKey("message", message.id, "tool-result");
    const isExpanded = state.expandedToolCards.has(cardKey);
    return html`
      <details
        class="pp-tool-card"
        style="margin-bottom:0.5rem;"
        ?open=${isExpanded}
        @toggle=${(event: Event) => handleToolCardToggle(cardKey, event)}
      >
        <summary class="pp-tool-summary">
          <span class="pp-tool-name">\ud83d\udee0 Tool result</span>
        </summary>
        ${isExpanded ? html`<div class="pp-tool-content">${renderStructuredBlock(message.text)}</div>` : nothing}
      </details>
    `;
  }

  // Extension / custom messages
  return html`
    <div class="pp-msg-assistant" style="opacity:0.85;">
      <div style="font-size:0.6875rem;font-weight:600;text-transform:uppercase;color:var(--pp-text-muted);margin-bottom:0.125rem;">
        ${message.role}
      </div>
      ${renderMarkdown(message.text)}
    </div>
  `;
}

/* ─── Tool cards ─── */

function renderToolCard(tool: ApiSessionSnapshot["toolExecutions"][number]) {
  const cardKey = getToolCardKey("execution", tool.toolCallId);
  const isExpanded = tool.status === "running" || state.expandedToolCards.has(cardKey);
  return html`
    <details class="pp-tool-card" ?open=${isExpanded} @toggle=${(event: Event) => handleToolCardToggle(cardKey, event)}>
      <summary class="pp-tool-summary">
        <span class="pp-tool-name">${tool.toolName}</span>
        <span class="pp-tool-status ${tool.status}">${tool.status}</span>
      </summary>
      ${isExpanded ? html`<div class="pp-tool-content">${tool.text ? renderStructuredBlock(tool.text) : "Running\u2026"}</div>` : nothing}
    </details>
  `;
}

/* ─── Menu dropdown ─── */

function renderMenu() {
  return html`
    <div class="pp-menu-overlay" @click=${() => { state.showMenu = false; renderApp(); }}>
      <div class="pp-menu" @click=${(e: Event) => e.stopPropagation()}>
        <button class="pp-menu-item" @click=${openActions}>
          \u2699\ufe0f Settings
        </button>
        <button class="pp-menu-item" @click=${toggleTokenUsage}>
          $ Token usage ${state.showTokenUsage ? html`<span class="check">\u2713</span>` : nothing}
        </button>
        <div class="pp-menu-divider"></div>
        <div class="pp-menu-section">Color Theme</div>
        <button class="pp-menu-item" @click=${() => setColorTheme("default")}>
          Default ${state.colorTheme === "default" ? html`<span class="check">\u2713</span>` : nothing}
        </button>
        <button class="pp-menu-item" @click=${() => setColorTheme("gruvbox")}>
          Gruvbox ${state.colorTheme === "gruvbox" ? html`<span class="check">\u2713</span>` : nothing}
        </button>
        <button class="pp-menu-item" @click=${() => setColorTheme("ghostty")}>
          Ghostty ${state.colorTheme === "ghostty" ? html`<span class="check">\u2713</span>` : nothing}
        </button>
        <div class="pp-menu-divider"></div>
        <div class="pp-menu-section">Appearance</div>
        <button class="pp-menu-item" @click=${() => setThemeMode("light")}>
          \u2600\ufe0f Light ${state.themeMode === "light" ? html`<span class="check">\u2713</span>` : nothing}
        </button>
        <button class="pp-menu-item" @click=${() => setThemeMode("dark")}>
          \ud83c\udf19 Dark ${state.themeMode === "dark" ? html`<span class="check">\u2713</span>` : nothing}
        </button>
        <button class="pp-menu-item" @click=${() => setThemeMode("system")}>
          \ud83d\udcbb System ${state.themeMode === "system" ? html`<span class="check">\u2713</span>` : nothing}
        </button>
      </div>
    </div>
  `;
}

/* ─── External change banner ─── */

function renderExternalBanner() {
  return html`
    <div class="pp-external-banner">
      <span>Session changed outside web. </span>
      <button @click=${reopenActiveSession} ?disabled=${state.isReopeningSession}>
        ${state.isReopeningSession ? "Reloading\u2026" : "Reload from disk"}
      </button>
      <button @click=${openActions}>Actions</button>
    </div>
  `;
}

/* ─── Attachments row ─── */

function renderAttachmentsRow() {
  return html`
    <div class="pp-attachments">
      ${state.attachments.map(
        (a) => html`
          <div class="pp-attachment-thumb">
            ${a.preview
              ? html`<img src="data:${a.mimeType};base64,${a.preview}" alt=${a.fileName} />`
              : html`<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:0.5rem;color:var(--pp-text-muted);">IMG</div>`}
            <button class="pp-attachment-remove" @click=${() => removeAttachment(a.id)}>\u00d7</button>
          </div>
        `,
      )}
    </div>
  `;
}

/* ─── Extension widgets ─── */

function renderExtensionWidgets(placement: "aboveEditor" | "belowEditor") {
  const widgets = state.extensionWidgets.filter((w) => w.placement === placement);
  if (widgets.length === 0) return nothing;
  return html`
    <div style="padding:0 1rem;">
      ${widgets.map(
        (w) => html`
          <div style="margin-bottom:0.5rem;padding:0.5rem 0.75rem;border:1px solid var(--pp-border);border-radius:0.375rem;background:var(--pp-bg-secondary);">
            <div style="font-size:0.625rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--pp-text-muted);margin-bottom:0.25rem;">${w.key}</div>
            <pre style="font-size:0.75rem;line-height:1.5;color:var(--pp-text-muted);white-space:pre-wrap;word-break:break-word;margin:0;">${w.lines.join("\n")}</pre>
          </div>
        `,
      )}
    </div>
  `;
}

/* ─── Toasts ─── */

function renderToasts() {
  if (state.extensionNotifications.length === 0) return nothing;
  return html`
    <div class="pp-toasts">
      ${state.extensionNotifications.map((n) => html`
        <div class="pp-toast ${n.notifyType}">
          <div class="pp-toast-type">${n.notifyType}</div>
          <div>${n.message}</div>
        </div>
      `)}
    </div>
  `;
}

function renderSlashCommandPalette() {
  const visibleSlashCommands = getVisibleSlashCommands();
  if (visibleSlashCommands.length === 0) {
    return nothing;
  }

  return html`
    <div class="pp-slash-commands">
      <div class="pp-slash-commands-title">Commands</div>
      ${visibleSlashCommands.map((command, index) => html`
        <button
          class="pp-slash-command-item ${index === state.selectedSlashCommandIndex ? "active" : ""}"
          @mousedown=${(event: Event) => {
            event.preventDefault();
            applySlashCommandSelection(command);
          }}
        >
          <div class="pp-slash-command-header">
            <span class="pp-slash-command-name">/${command.name}</span>
            <span class="pp-slash-command-source">${getSlashCommandSourceLabel(command)}</span>
          </div>
          ${command.description
            ? html`<div class="pp-slash-command-desc">${command.description}</div>`
            : nothing}
          ${command.source === "builtin" && !isSlashCommandSupportedInWeb(command)
            ? html`<div class="pp-slash-command-note">Not available in Pi Web yet.</div>`
            : nothing}
        </button>
      `)}
    </div>
  `;
}

/* ─── Models dialog ─── */

function renderModelsDialog() {
  const visibleModels = getVisibleModels();
  const currentModelKey = state.activeSession?.model
    ? getModelKey(state.activeSession.model.provider, state.activeSession.model.id)
    : undefined;

  return html`
    <div class="pp-dialog-overlay" @click=${() => { state.showModels = false; renderApp(); }}>
      <div class="pp-dialog" @click=${(e: Event) => e.stopPropagation()}>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
          <div class="pp-dialog-title">Models</div>
          <div style="display:flex;gap:0.375rem;">
            <button class="pp-dialog-btn" @click=${cycleModel}>Cycle</button>
            <button class="pp-dialog-btn" @click=${() => { state.showModels = false; renderApp(); }}>Done</button>
          </div>
        </div>
        <input
          class="pp-dialog-input"
          style="margin-bottom:0.5rem;"
          .value=${live(state.modelSearch)}
          @input=${(event: Event) => {
            state.modelSearch = (event.target as HTMLInputElement).value;
            renderApp();
          }}
          placeholder="Search models…"
        />
        <div class="pp-dialog-subtitle">
          Search by name, provider, or model ID. Recently used models stay pinned at the top.
        </div>
        ${visibleModels.length
          ? visibleModels.map((model) => {
              const modelKey = getModelKey(model.provider, model.id);
              const isCurrent = modelKey === currentModelKey;
              const isRecent = state.recentModelKeys.includes(modelKey);
              return html`
                <button class="pp-dialog-item" @click=${() => setModel(model.provider, model.id)}>
                  <div class="pp-dialog-item-header">
                    <div class="pp-dialog-item-title">${model.name}</div>
                    <div class="pp-dialog-item-badges">
                      ${isCurrent ? html`<span class="pp-dialog-item-badge current">Current</span>` : nothing}
                      ${isRecent ? html`<span class="pp-dialog-item-badge">Recent</span>` : nothing}
                    </div>
                  </div>
                  <div class="pp-dialog-item-desc">${model.provider}/${model.id}</div>
                </button>
              `;
            })
          : html`<div class="pp-dialog-empty">No models match your search.</div>`}
      </div>
    </div>
  `;
}

/* ─── Actions dialog ─── */

function renderActionsDialog() {
  return html`
    <div class="pp-dialog-overlay" @click=${() => { state.showActions = false; renderApp(); }}>
      <div class="pp-dialog" @click=${(e: Event) => e.stopPropagation()}>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
          <div class="pp-dialog-title">Session actions</div>
          <button class="pp-dialog-btn" @click=${() => { state.showActions = false; renderApp(); }}>Done</button>
        </div>

        <div class="pp-dialog-section">
          <div class="pp-dialog-section-title">Rename session</div>
          <div class="pp-dialog-section-desc">Set a persistent display name.</div>
          <input
            class="pp-dialog-input"
            style="margin-bottom:0.5rem;"
            .value=${state.renameText}
            @input=${(e: Event) => { state.renameText = (e.target as HTMLInputElement).value; }}
            placeholder="Refactor auth module"
          />
          <button class="pp-dialog-btn" @click=${renameSession}>Save name</button>
        </div>

        <div class="pp-dialog-section">
          <div class="pp-dialog-section-title">Navigate tree</div>
          <div class="pp-dialog-section-desc">Jump to an earlier prompt inside the same session.</div>
          ${state.isLoadingTreeMessages
            ? html`<div style="font-size:0.8125rem;color:var(--pp-text-muted);">Loading\u2026</div>`
            : state.treeMessages.length
              ? state.treeMessages.map(
                  (m) => html`
                    <button class="pp-dialog-item" @click=${() => navigateTree(m.entryId)}>
                      <div class="pp-dialog-item-title">${truncate(m.text, 120)}</div>
                      <div class="pp-dialog-item-desc">
                        ${m.isOnCurrentPath ? "current path \u2022 " : ""}Switch inside this session
                      </div>
                    </button>
                  `,
                )
              : html`<div style="font-size:0.8125rem;color:var(--pp-text-muted);">No prompts for tree navigation yet.</div>`}
        </div>

        <div class="pp-dialog-section">
          <div class="pp-dialog-section-title">Fork from earlier prompt</div>
          <div class="pp-dialog-section-desc">Create a new session from a previous message.</div>
          ${state.isLoadingForkMessages
            ? html`<div style="font-size:0.8125rem;color:var(--pp-text-muted);">Loading\u2026</div>`
            : state.forkMessages.length
              ? state.forkMessages.map(
                  (m) => html`
                    <button class="pp-dialog-item" @click=${() => forkFromEntry(m.entryId)}>
                      <div class="pp-dialog-item-title">${truncate(m.text, 120)}</div>
                      <div class="pp-dialog-item-desc">Create a separate session</div>
                    </button>
                  `,
                )
              : html`<div style="font-size:0.8125rem;color:var(--pp-text-muted);">No prompts for forking yet.</div>`}
        </div>
      </div>
    </div>
  `;
}

/* ─── Extension UI dialog ─── */

function renderExtensionUiDialog(request: ApiExtensionUiRequest) {
  return html`
    <div class="pp-dialog-overlay" @click=${() => submitExtensionUiResponse({ cancelled: true })}>
      <div class="pp-dialog" @click=${(e: Event) => e.stopPropagation()}>
        <div class="pp-dialog-title">${request.title}</div>
        ${request.message ? html`<div class="pp-dialog-subtitle">${request.message}</div>` : nothing}
        ${request.timeout
          ? html`<div style="font-size:0.75rem;color:var(--pp-text-muted);margin-bottom:0.5rem;">Expires in ~${Math.ceil(request.timeout / 1000)}s</div>`
          : nothing}

        ${request.method === "select"
          ? html`${request.options?.map(
              (opt) => html`
                <button class="pp-dialog-item" @click=${() => submitExtensionUiResponse({ value: opt })}>
                  ${opt}
                </button>
              `,
            )}`
          : nothing}

        ${request.method === "confirm"
          ? html`
              <div style="display:flex;gap:0.375rem;">
                <button class="pp-dialog-btn" style="flex:1;" @click=${() => submitExtensionUiResponse({ cancelled: true })}>Cancel</button>
                <button class="pp-dialog-btn primary" style="flex:1;" @click=${() => submitExtensionUiResponse({ confirmed: true })}>Confirm</button>
              </div>
            `
          : nothing}

        ${request.method === "input" || request.method === "editor"
          ? html`
              ${request.method === "input"
                ? html`<input
                    class="pp-dialog-input"
                    style="margin-bottom:0.5rem;"
                    .value=${state.extensionUiValue}
                    @input=${(e: Event) => { state.extensionUiValue = (e.target as HTMLInputElement).value; renderApp(); }}
                    placeholder=${request.placeholder ?? ""}
                  />`
                : html`<textarea
                    class="pp-dialog-input"
                    style="margin-bottom:0.5rem;min-height:10rem;font-family:monospace;"
                    .value=${state.extensionUiValue}
                    @input=${(e: Event) => { state.extensionUiValue = (e.target as HTMLTextAreaElement).value; renderApp(); }}
                    placeholder=${request.placeholder ?? ""}
                  ></textarea>`}
              <div style="display:flex;gap:0.375rem;">
                <button class="pp-dialog-btn" style="flex:1;" @click=${() => submitExtensionUiResponse({ cancelled: true })}>Cancel</button>
                <button class="pp-dialog-btn primary" style="flex:1;" @click=${() => submitExtensionUiResponse({ value: state.extensionUiValue })}>Submit</button>
              </div>
            `
          : nothing}
      </div>
    </div>
  `;
}

/* ─── Loading skeleton ─── */

function renderSkeleton() {
  return html`
    <div style="padding:1rem 0;">
      ${[80, 65, 90].map(
        (w) => html`
          <div style="margin-bottom:0.75rem;">
            <div class="pp-skeleton-bar" style="width:${w}%;height:0.75rem;margin-bottom:0.375rem;"></div>
            <div class="pp-skeleton-bar" style="width:${w - 20}%;height:0.625rem;"></div>
          </div>
        `,
      )}
    </div>
  `;
}

/* ─── API helpers ─── */

async function apiGet<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const init: RequestInit = {
    credentials: "same-origin",
  };
  if (options.signal) {
    init.signal = options.signal;
  }
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

async function apiPost<T>(path: string, body: unknown, options: ApiRequestOptions = {}): Promise<T> {
  const init: RequestInit = {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  if (options.signal) {
    init.signal = options.signal;
  }
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function isSessionNotFoundError(error: unknown) {
  return /session not found/i.test(getErrorMessage(error));
}

if (typeof sidebarMediaQuery.addEventListener === "function") {
  sidebarMediaQuery.addEventListener("change", handleSidebarViewportChange);
} else {
  sidebarMediaQuery.addListener(handleSidebarViewportChange);
}

await bootstrap();
