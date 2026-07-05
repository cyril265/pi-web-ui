import { html, render, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { BUILTIN_SLASH_COMMANDS } from "@pi-web-app/shared";
import type {
  ApiDirectoryListing,
  ApiForkMessage,
  ApiImageInput,
  ApiModelInfo,
  ApiSlashCommand,
  ApiSessionListItem,
  ApiSessionPatch,
  ApiSessionSnapshot,
  ApiTreeMessage,
  SessionCatalogEvent,
  SessionEvent,
  ThinkingLevel,
} from "@pi-web-app/shared";
import {
  clearRenderedMessageCaches,
  copyMessageText,
  handleCodeCopyClick,
  isUserPromptMessage,
  renderConversation,
  renderToolCard,
} from "./conversation-rendering";
import type { MessageActionContext } from "./conversation-rendering";
import { ExtensionUi } from "./extension-ui";
import { ProjectSessionDialog } from "./project-session-dialog";
import "./app.css";

/* ─── Types ─── */

type ComposerMode = "prompt" | "steer" | "follow-up";

type PendingAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
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
type DisplayMode = "default" | "dense";
type LiveConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";
type ApiRequestOptions = {
  signal?: AbortSignal;
};
type SessionSelection = {
  token: number;
  signal: AbortSignal;
};
type MessageActionTarget = {
  entryId: string;
  promptText: string;
  promptMessage: ApiSessionSnapshot["messages"][number];
  selectedMessage: ApiSessionSnapshot["messages"][number];
  usesNearestPrompt: boolean;
};
type ForkFromEntryOptions = {
  info?: string;
  composerMode?: ComposerMode;
  focusComposer?: boolean;
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
  pageTitle: string | undefined;
  renameText: string;
  isLoading: boolean;
  isSubmittingComposer: boolean;
  isLoadingForkMessages: boolean;
  isLoadingTreeMessages: boolean;
  isReopeningSession: boolean;
  showMenu: boolean;
  showModels: boolean;
  showThinkingLevels: boolean;
  showActions: boolean;
  showTokenUsage: boolean;
  error: string | undefined;
  info: string | undefined;
  liveConnectionState: LiveConnectionState;
  switchingSessionId: string | undefined;
  sidebarOpen: boolean;
  themeMode: ThemeMode;
  colorTheme: ColorTheme;
  displayMode: DisplayMode;
  expandedToolCards: Set<string>;
};

/* ─── State ─── */

const MOBILE_SIDEBAR_MEDIA_QUERY = "(max-width: 900px)";
const RECENT_MODELS_STORAGE_KEY = "recent-models";
const DISPLAY_MODE_STORAGE_KEY = "display-mode";
const ACTIVE_SESSION_FILE_STORAGE_KEY = "active-session-file";
const RECENT_MODELS_LIMIT = 8;
const MAX_VISIBLE_SLASH_COMMANDS = 8;
const FILTER_INPUT_RENDER_DELAY_MS = 100;
const AUTO_SCROLL_NEAR_BOTTOM_THRESHOLD_PX = 64;
const DEFAULT_VISIBLE_MESSAGE_WINDOW = 200;
const MESSAGE_WINDOW_STEP = 200;
const sidebarMediaQuery = window.matchMedia(MOBILE_SIDEBAR_MEDIA_QUERY);
const appRoot = document.getElementById("app");

function loadRecentModelKeys() {
  return (localStorage.getItem(RECENT_MODELS_STORAGE_KEY) ?? "")
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

function getStoredActiveSessionFile() {
  const sessionFile = localStorage.getItem(ACTIVE_SESSION_FILE_STORAGE_KEY)?.trim();
  return sessionFile ? sessionFile : undefined;
}

function storeActiveSessionFile(sessionFile: string | undefined) {
  if (sessionFile) {
    localStorage.setItem(ACTIVE_SESSION_FILE_STORAGE_KEY, sessionFile);
    return;
  }

  localStorage.removeItem(ACTIVE_SESSION_FILE_STORAGE_KEY);
}

function loadDisplayMode(): DisplayMode {
  return localStorage.getItem(DISPLAY_MODE_STORAGE_KEY) === "dense" ? "dense" : "default";
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
  pageTitle: undefined,
  renameText: "",
  isLoading: true,
  isSubmittingComposer: false,
  isLoadingForkMessages: false,
  isLoadingTreeMessages: false,
  isReopeningSession: false,
  showMenu: false,
  showModels: false,
  showThinkingLevels: false,
  showActions: false,
  showTokenUsage: (localStorage.getItem("showTokenUsage") ?? "true") === "true",
  error: undefined,
  info: undefined,
  liveConnectionState: "disconnected",
  switchingSessionId: undefined,
  sidebarOpen: !sidebarMediaQuery.matches,
  themeMode: (localStorage.getItem("theme") as ThemeMode) || "system",
  colorTheme: (localStorage.getItem("color-theme") as ColorTheme) || "ghostty",
  displayMode: loadDisplayMode(),
  expandedToolCards: new Set<string>(),
};

let currentEvents: EventSource | undefined;
let sessionListEvents: EventSource | undefined;
let currentSessionSelection = 0;
let currentSessionSelectionController = new AbortController();
let eventReconnectTimeout: ReturnType<typeof setTimeout> | undefined;
let eventReconnectAttempts = 0;
let sessionListReconnectTimeout: ReturnType<typeof setTimeout> | undefined;
let sessionListRefreshTimeout: ReturnType<typeof setTimeout> | undefined;
let sessionsLoadRequestId = 0;
let slashCommandsLoadRequestId = 0;
const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
let messagesContainer: HTMLElement | null = null;
let renderRequested = false;
let followLatestMessages = true;
let scrollToBottomRequested = false;
let scrollToBottomForceRequested = false;
const EVENT_RECONNECT_BASE_DELAY_MS = 1_000;
const EVENT_RECONNECT_MAX_DELAY_MS = 10_000;
const SESSION_LIST_EVENT_RECONNECT_MS = 3_000;
const SESSION_LIST_REFRESH_DEBOUNCE_MS = 250;
const SIDEBAR_RELATIVE_TIME_REFRESH_MS = 30_000;
const EXTENSION_LAYOUT_SYNC_DEBOUNCE_MS = 120;
const SESSION_SWITCH_FEEDBACK_MS = 150;
let extensionLayoutSyncTimeout: ReturnType<typeof setTimeout> | undefined;
let sidebarRelativeTimeRefreshInterval: ReturnType<typeof setInterval> | undefined;
let lastReportedExtensionLayout: { sessionId: string; columns: number } | undefined;
let visibleMessageWindow = DEFAULT_VISIBLE_MESSAGE_WINDOW;
const sessionDirectoryOverrides = new Map<string, string>();
const requestInputRender = (() => {
  let timeoutId: number | undefined;
  return () => {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
    timeoutId = window.setTimeout(() => {
      timeoutId = undefined;
      requestRender();
    }, FILTER_INPUT_RENDER_DELAY_MS);
  };
})();

function startSidebarRelativeTimeRefresh() {
  if (sidebarRelativeTimeRefreshInterval !== undefined) {
    return;
  }

  sidebarRelativeTimeRefreshInterval = setInterval(() => {
    if (state.sessions.length > 0) {
      requestRender();
    }
  }, SIDEBAR_RELATIVE_TIME_REFRESH_MS);
}

const extensionUi = new ExtensionUi({
  getSessionId: () => state.activeSession?.sessionId,
  requestRender,
  submitResponse: async (sessionId, response) => {
    await apiPost(`/api/sessions/${sessionId}/ui-response`, response);
  },
});

const projectSessionDialog = new ProjectSessionDialog({
  getInitialProjectPath: () => getActiveSessionListItem()?.cwd,
  requestRender,
  listDirectories: async (path) => await apiGet<ApiDirectoryListing>(
    path ? `/api/directories?path=${encodeURIComponent(path)}` : "/api/directories",
  ),
  createSession: async (projectPath) => Boolean(await createSession(projectPath)),
  onSessionCreated: (projectPath) => {
    if (!state.activeSession) {
      return;
    }

    setSessionDirectoryOverride(state.activeSession, projectPath);

    const activeSessionListItem = getActiveSessionListItem();
    if (activeSessionListItem) {
      activeSessionListItem.cwd = projectPath;
    }

    closeSidebarIfMobile();
  },
});



function formatThinkingLevel(level: ThinkingLevel | undefined) {
  switch (level) {
    case "off":
      return "Off";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "XHigh";
    default:
      return level ? String(level) : "Off";
  }
}

function getVisibleThinkingLevels() {
  const currentLevel = state.activeSession?.thinkingLevel;
  return currentLevel && !levels.includes(currentLevel) ? [currentLevel, ...levels] : levels;
}



/* ─── API / state logic ─── */

async function bootstrap() {
  applyTheme();
  applyDisplayMode();
  startSidebarRelativeTimeRefresh();
  connectSessionListEvents();
  try {
    await Promise.all([loadSessions(), loadModels()]);
    const storedSessionFile = getStoredActiveSessionFile();
    const preferredSession = storedSessionFile
      ? state.sessions.find((session) => session.sessionFile === storedSessionFile)
      : undefined;
    const firstSession = preferredSession ?? state.sessions[0];
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
    requestRender();
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
  requestRender();
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
  requestRender();
}

function refreshSessionsInBackground(scope = state.sessionsScope) {
  void loadSessions(scope).catch((error) => {
    state.error = getErrorMessage(error);
    requestRender();
  });
}

function scheduleSessionListRefresh() {
  if (sessionListRefreshTimeout) {
    clearTimeout(sessionListRefreshTimeout);
  }

  sessionListRefreshTimeout = setTimeout(() => {
    sessionListRefreshTimeout = undefined;
    refreshSessionsInBackground();
  }, SESSION_LIST_REFRESH_DEBOUNCE_MS);
}

function connectSessionListEvents() {
  if (sessionListReconnectTimeout) {
    clearTimeout(sessionListReconnectTimeout);
    sessionListReconnectTimeout = undefined;
  }

  sessionListEvents?.close();
  const events = new EventSource("/api/sessions/events");
  sessionListEvents = events;

  events.onmessage = (messageEvent) => {
    if (sessionListEvents !== events) return;
    const event = JSON.parse(messageEvent.data) as SessionCatalogEvent;
    if (event.type === "sessions_changed") {
      scheduleSessionListRefresh();
    }
  };

  events.onerror = () => {
    if (sessionListEvents !== events) return;
    events.close();
    sessionListEvents = undefined;
    sessionListReconnectTimeout = setTimeout(connectSessionListEvents, SESSION_LIST_EVENT_RECONNECT_MS);
  };
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
    requestRender();
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
      requestRender();
    }
    throw error;
  }
}

async function createSession(projectPath?: string) {
  const trimmedProjectPath = projectPath?.trim();
  return await loadAndOpenSnapshot(
    async (signal) => {
      const response = await apiPost<{ snapshot: ApiSessionSnapshot }>(
        "/api/sessions",
        trimmedProjectPath ? { path: trimmedProjectPath } : {},
        { signal },
      );
      return response.snapshot;
    },
    { refreshSessions: true },
  );
}

async function handleCreateSession() {
  await createSession();
  closeSidebarIfMobile();
}

function openProjectSessionDialog() {
  state.showMenu = false;
  projectSessionDialog.open();
}

async function openSession(sessionFile: string) {
  return await loadAndOpenSnapshot(async (signal) => {
    const response = await apiPost<{ snapshot: ApiSessionSnapshot }>(
      "/api/sessions/open",
      { path: sessionFile },
      { signal },
    );
    return response.snapshot;
  });
}

async function attachToLiveSession(sessionId: string) {
  return await loadAndOpenSnapshot(async (signal) => {
    const response = await apiGet<{ snapshot: ApiSessionSnapshot }>(`/api/sessions/${sessionId}`, { signal });
    return response.snapshot;
  });
}

async function sendComposer() {
  if (!state.activeSession || state.isLoading || state.switchingSessionId) return;
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
    requestRender();
    return;
  }

  if (slashCommand?.source === "builtin") {
    if (submittedAttachments.length > 0) {
      state.error = `/${slashCommand.name} does not accept image attachments in Pi Web.`;
      requestRender();
      return;
    }

    state.isSubmittingComposer = true;
    state.error = undefined;
    state.info = undefined;
    requestRender();

    try {
      await executeBuiltinSlashCommand(slashCommand.name, parsedSlashCommand?.args ?? "");
      state.composerText = "";
      state.attachments = [];
    } catch (error) {
      state.error = getErrorMessage(error);
    } finally {
      state.isSubmittingComposer = false;
      requestRender();
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
  requestRender();
  if (pendingSubmission) {
    scrollToBottom({ force: true });
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
    requestRender();
  } finally {
    state.isSubmittingComposer = false;
    requestRender();
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
  state.showThinkingLevels = false;
  state.modelSearch = "";
  requestRender();
}

function openThinkingLevelsDialog() {
  state.showThinkingLevels = true;
  state.showModels = false;
  requestRender();
}

async function setModel(provider: string, modelId: string) {
  if (!state.activeSession) return;
  await apiPost(`/api/sessions/${state.activeSession.sessionId}/model`, { provider, modelId });
  rememberRecentModel(provider, modelId);
  state.showModels = false;
  state.modelSearch = "";
}

async function setThinkingLevel(level: ThinkingLevel) {
  const activeSession = state.activeSession;
  if (!activeSession) return;
  await apiPost(`/api/sessions/${activeSession.sessionId}/thinking-level`, { thinkingLevel: level });
  if (state.activeSession?.sessionId === activeSession.sessionId) {
    state.activeSession.thinkingLevel = level;
    syncSessionListItem(state.activeSession, { touchLastModified: false });
  }
  state.showThinkingLevels = false;
  requestRender();
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
  requestRender();

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
      requestRender();
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
  requestRender();
}

async function reopenActiveSession() {
  if (!state.activeSession || state.isReopeningSession) return;
  const sessionId = state.activeSession.sessionId;
  state.isReopeningSession = true;
  requestRender();
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
    requestRender();
  }
}

async function forkFromEntry(entryId: string, options: ForkFromEntryOptions = {}) {
  if (!state.activeSession) return;
  const sessionId = state.activeSession.sessionId;
  const response = await apiPost<{ cancelled: boolean; selectedText: string; snapshot: ApiSessionSnapshot }>(
    `/api/sessions/${sessionId}/fork`,
    { entryId },
  );
  if (response.cancelled) return response;
  const activeSessionId = state.activeSession?.sessionId;
  if (
    activeSessionId &&
    activeSessionId !== sessionId &&
    activeSessionId !== response.snapshot.sessionId
  ) {
    refreshSessionsInBackground();
    return response;
  }
  state.composerText = response.selectedText;
  if (options.composerMode) {
    state.composerMode = options.composerMode;
  }
  state.showActions = false;
  openSnapshot(response.snapshot);
  refreshSessionsInBackground();
  state.info = options.info ?? "Fork created. The selected prompt was copied into the composer.";
  requestRender();
  if (options.focusComposer) {
    focusComposerInput();
  }
  return response;
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
  requestRender();
}

const pastedClipboardImagePathPattern = /(?:^|\/)pi-clipboard-[\w-]+\.(png|jpe?g|gif|webp)$/i;

async function addImageAttachments(files: readonly File[]) {
  if (files.length === 0) return;

  const { loadAttachment } = await import("@earendil-works/pi-web-ui");
  const loaded = await Promise.all(files.map((file) => loadAttachment(file)));
  const images = loaded.filter((a) => a.type === "image");
  const ignoredCount = loaded.length - images.length;

  state.attachments = [
    ...state.attachments,
    ...images.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      data: a.content,
    })),
  ];

  if (ignoredCount > 0) {
    state.info = `${ignoredCount} non-image attachment(s) were skipped.`;
  }

  requestRender();
}

async function importClipboardImageAttachment(path: string) {
  const response = await apiPost<{
    attachment: {
      fileName: string;
      mimeType: string;
      data: string;
    };
  }>("/api/clipboard-image", { path });

  state.attachments = [
    ...state.attachments,
    {
      id: `clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      fileName: response.attachment.fileName,
      mimeType: response.attachment.mimeType,
      data: response.attachment.data,
    },
  ];

  requestRender();
}

async function handleFiles(files: FileList | null) {
  if (!files?.length) return;
  await addImageAttachments([...files]);
}

async function handleComposerPaste(event: ClipboardEvent) {
  const clipboardItems = [...(event.clipboardData?.items ?? [])];
  const imageFiles = clipboardItems
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));

  if (imageFiles.length > 0) {
    event.preventDefault();
    await addImageAttachments(imageFiles);
    return;
  }

  const pastedText = event.clipboardData?.getData("text/plain")?.trim();
  if (!pastedText || !pastedClipboardImagePathPattern.test(pastedText)) return;

  event.preventDefault();

  try {
    await importClipboardImageAttachment(pastedText);
  } catch (error) {
    state.error = getErrorMessage(error);
    requestRender();
  }
}



function getSessionPreviewFromSnapshot(snapshot: ApiSessionSnapshot) {
  const firstUserMessage = snapshot.messages.find((message) =>
    message.role === "user" || message.role === "user-with-attachments",
  );
  return firstUserMessage?.text ?? "";
}

function getSnapshotLastModified(
  snapshot: ApiSessionSnapshot,
  existing: ApiSessionListItem | undefined,
  options: { touch?: boolean } = {},
) {
  if (options.touch === false) {
    return existing?.lastModified;
  }

  const timestamps = [
    snapshot.toolExecutions.at(-1)?.updatedAt,
    [...snapshot.messages].reverse().find((message) => message.timestamp)?.timestamp,
    existing?.lastModified,
  ].filter((value): value is string => Boolean(value));

  return timestamps.sort().at(-1);
}

function sortSessionListByLastModified(sessions: ApiSessionListItem[]) {
  return [...sessions].sort((left, right) => (right.lastModified ?? "").localeCompare(left.lastModified ?? ""));
}

function syncSessionListItem(
  snapshot: ApiSessionSnapshot,
  options: { touchLastModified?: boolean; preservePosition?: boolean } = {},
) {
  const existingIndex = state.sessions.findIndex((session) =>
    session.id === snapshot.sessionId || (snapshot.sessionFile && session.sessionFile === snapshot.sessionFile),
  );
  const existing = existingIndex === -1 ? undefined : state.sessions[existingIndex];
  const overriddenCwd = getSessionDirectoryOverride(snapshot);
  const nextSession: ApiSessionListItem = {
    id: snapshot.sessionId,
    sessionFile: snapshot.sessionFile ?? existing?.sessionFile,
    cwd: existing?.cwd ?? overriddenCwd,
    isInCurrentWorkspace: existing?.isInCurrentWorkspace ?? true,
    title: snapshot.title,
    preview: getSessionPreviewFromSnapshot(snapshot),
    lastModified: getSnapshotLastModified(snapshot, existing, { touch: options.touchLastModified ?? true }),
    messageCount: snapshot.messages.length,
    modelId: snapshot.model?.id,
    thinkingLevel: snapshot.thinkingLevel,
    status: snapshot.status,
    live: true,
    externallyDirty: snapshot.externallyDirty,
  };

  if (options.preservePosition && existingIndex !== -1) {
    state.sessions = [
      ...state.sessions.slice(0, existingIndex),
      nextSession,
      ...state.sessions.slice(existingIndex + 1),
    ];
    return;
  }

  const remainingSessions = state.sessions.filter((session) =>
    session.id !== snapshot.sessionId && (!snapshot.sessionFile || session.sessionFile !== snapshot.sessionFile),
  );
  state.sessions = sortSessionListByLastModified([nextSession, ...remainingSessions]);
}

function sortToolExecutions(toolExecutions: ApiSessionSnapshot["toolExecutions"]) {
  return [...toolExecutions].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function modelsEqual(left: ApiSessionSnapshot["model"], right: ApiSessionSnapshot["model"]) {
  return left?.provider === right?.provider && left?.id === right?.id && left?.name === right?.name;
}

function contextUsageEqual(
  left: ApiSessionSnapshot["contextUsage"],
  right: ApiSessionSnapshot["contextUsage"],
) {
  return left?.tokens === right?.tokens
    && left?.contextWindow === right?.contextWindow
    && left?.percent === right?.percent;
}

function hasOwn(value: object, key: PropertyKey) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function applySessionPatch(patch: ApiSessionPatch) {
  const activeSession = state.activeSession;
  if (!activeSession) {
    return;
  }

  let changed = false;

  if (hasOwn(patch, "sessionFile") && activeSession.sessionFile !== patch.sessionFile) {
    activeSession.sessionFile = patch.sessionFile;
    changed = true;
  }
  if (hasOwn(patch, "title") && patch.title !== undefined && activeSession.title !== patch.title) {
    activeSession.title = patch.title;
    state.renameText = patch.title;
    state.pageTitle = patch.title;
    document.title = patch.title;
    changed = true;
  }
  if (hasOwn(patch, "status") && patch.status !== undefined && activeSession.status !== patch.status) {
    activeSession.status = patch.status;
    changed = true;
  }
  if (hasOwn(patch, "live") && patch.live !== undefined && activeSession.live !== patch.live) {
    activeSession.live = patch.live;
    changed = true;
  }
  if (
    hasOwn(patch, "externallyDirty")
    && patch.externallyDirty !== undefined
    && activeSession.externallyDirty !== patch.externallyDirty
  ) {
    activeSession.externallyDirty = patch.externallyDirty;
    changed = true;
  }
  if (hasOwn(patch, "model") && !modelsEqual(activeSession.model, patch.model)) {
    activeSession.model = patch.model;
    changed = true;
  }
  if (
    hasOwn(patch, "thinkingLevel")
    && patch.thinkingLevel !== undefined
    && activeSession.thinkingLevel !== patch.thinkingLevel
  ) {
    activeSession.thinkingLevel = patch.thinkingLevel;
    changed = true;
  }
  if (hasOwn(patch, "contextUsage") && !contextUsageEqual(activeSession.contextUsage, patch.contextUsage)) {
    activeSession.contextUsage = patch.contextUsage;
    changed = true;
  }

  if (!changed) {
    return false;
  }

  syncSessionListItem(activeSession, { touchLastModified: false });
  return true;
}

function applyMessagesDelta(fromIndex: number, messages: ApiSessionSnapshot["messages"]) {
  const activeSession = state.activeSession;
  if (!activeSession) {
    return false;
  }
  if (fromIndex < 0 || fromIndex > activeSession.messages.length) {
    void reconnectActiveSession(activeSession.sessionId);
    return false;
  }

  activeSession.messages = [...activeSession.messages.slice(0, fromIndex), ...messages];
  reconcilePendingComposerSubmissions(activeSession);
  syncSessionListItem(activeSession);
  return true;
}

function applyToolExecutionDelta(toolExecution: ApiSessionSnapshot["toolExecutions"][number]) {
  const activeSession = state.activeSession;
  if (!activeSession) {
    return false;
  }

  const existingIndex = activeSession.toolExecutions.findIndex((entry) => entry.toolCallId === toolExecution.toolCallId);
  activeSession.toolExecutions = existingIndex === -1
    ? sortToolExecutions([...activeSession.toolExecutions, toolExecution])
    : sortToolExecutions([
        ...activeSession.toolExecutions.slice(0, existingIndex),
        toolExecution,
        ...activeSession.toolExecutions.slice(existingIndex + 1),
      ]);
  syncSessionListItem(activeSession, { touchLastModified: false });
  return true;
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
    visibleMessageWindow = DEFAULT_VISIBLE_MESSAGE_WINDOW;
    clearRenderedMessageCaches();
    lastReportedExtensionLayout = undefined;
  }
  state.renameText = snapshot.title;
  storeActiveSessionFile(snapshot.sessionFile);
  if (options.resetSessionUi) {
    extensionUi.clearForSessionChange();
  }
  state.pageTitle = snapshot.title;
  document.title = state.pageTitle;
  syncSessionListItem(snapshot, { touchLastModified: false, preservePosition: true });
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
  followLatestMessages = true;
  refreshSlashCommandsInBackground(snapshot.sessionId);
  state.liveConnectionState = "connecting";
  connectEvents(snapshot.sessionId);
  requestRender();
  scrollToBottom({ force: true });
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
    requestRender();
  };

  events.onmessage = (messageEvent) => {
    if (currentEvents !== events || state.activeSession?.sessionId !== sessionId) return;
    const event = JSON.parse(messageEvent.data) as SessionEvent;

    switch (event.type) {
      case "snapshot": {
        const sessionChanged = applySnapshot(event.snapshot);
        if (sessionChanged) {
          state.liveConnectionState = "connecting";
          connectEvents(event.snapshot.sessionId);
          refreshSessionsInBackground();
          refreshSlashCommandsInBackground(event.snapshot.sessionId);
        }
        break;
      }
      case "session_patch":
        applySessionPatch(event.patch);
        break;
      case "messages_delta":
        applyMessagesDelta(event.fromIndex, event.messages);
        break;
      case "tool_execution_delta":
        applyToolExecutionDelta(event.toolExecution);
        break;
      case "error":
        state.error = event.message;
        break;
      case "info":
        state.info = event.message;
        break;
      case "extension_ui_request":
      case "extension_notify":
      case "set_status":
      case "set_widget":
      case "set_header":
      case "set_footer":
        extensionUi.applyEvent(event);
        break;
      case "set_editor_text":
        state.composerText = event.text;
        break;
      case "set_title":
        state.pageTitle = event.title;
        document.title = event.title;
        break;
    }

    requestRender();
    scrollToBottom();
  };

  events.onerror = () => {
    if (currentEvents !== events || state.activeSession?.sessionId !== sessionId) return;
    events.close();
    currentEvents = undefined;
    state.liveConnectionState = "reconnecting";
    requestRender();
    scheduleReconnect(sessionId);
  };
}

function scheduleExtensionLayoutSync() {
  if (extensionLayoutSyncTimeout) {
    clearTimeout(extensionLayoutSyncTimeout);
  }

  extensionLayoutSyncTimeout = setTimeout(() => {
    extensionLayoutSyncTimeout = undefined;
    void syncExtensionLayout();
  }, EXTENSION_LAYOUT_SYNC_DEBOUNCE_MS);
}

async function syncExtensionLayout() {
  const sessionId = state.activeSession?.sessionId;
  if (!sessionId) {
    lastReportedExtensionLayout = undefined;
    return;
  }

  const main = document.querySelector<HTMLElement>(".pp-main");
  const width = main?.clientWidth ?? 0;
  const columns = Math.max(40, Math.min(240, Math.round(Math.max(0, width - 32) / 8)));
  if (!Number.isFinite(columns)) {
    return;
  }

  if (lastReportedExtensionLayout?.sessionId === sessionId && lastReportedExtensionLayout.columns === columns) {
    return;
  }

  lastReportedExtensionLayout = { sessionId, columns };

  try {
    await apiPost(`/api/sessions/${sessionId}/layout`, { columns });
  } catch {
    if (lastReportedExtensionLayout?.sessionId === sessionId) {
      lastReportedExtensionLayout = undefined;
    }
  }
}

function setError(message: string) {
  state.error = message;
  requestRender();
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

function applyDisplayMode() {
  document.documentElement.setAttribute("data-display-mode", state.displayMode);
}

function setThemeMode(mode: ThemeMode) {
  state.themeMode = mode;
  localStorage.setItem("theme", mode);
  applyTheme();
  requestRender();
}

function setColorTheme(theme: ColorTheme) {
  state.colorTheme = theme;
  localStorage.setItem("color-theme", theme);
  applyTheme();
  requestRender();
}

function setDisplayMode(mode: DisplayMode) {
  state.displayMode = mode;
  localStorage.setItem(DISPLAY_MODE_STORAGE_KEY, mode);
  applyDisplayMode();
  requestRender();
}

function toggleTokenUsage() {
  state.showTokenUsage = !state.showTokenUsage;
  localStorage.setItem("showTokenUsage", String(state.showTokenUsage));
  requestRender();
}

/* ─── Helpers ─── */

function isMobileSidebarLayout() {
  return sidebarMediaQuery.matches;
}

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  state.showMenu = false;
  requestRender();
}

function closeSidebar() {
  if (!state.sidebarOpen) return;
  state.sidebarOpen = false;
  requestRender();
}

function closeSidebarIfMobile() {
  if (!isMobileSidebarLayout()) return;
  closeSidebar();
}

function handleSidebarViewportChange(event: MediaQueryListEvent | MediaQueryList) {
  state.sidebarOpen = !event.matches;
  if (appRoot) {
    requestRender();
  }
}

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
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

function handleSessionsSearchInput(event: Event) {
  state.sessionsSearch = (event.target as HTMLInputElement).value;
  requestInputRender();
}

function handleComposerInput(event: Event) {
  const nextText = (event.target as HTMLTextAreaElement).value;
  const hadSlashCommandQuery = getSlashCommandQuery(state.composerText) !== undefined;

  state.composerText = nextText;
  state.selectedSlashCommandIndex = 0;

  const hasSlashCommandQuery = getSlashCommandQuery(nextText) !== undefined;
  if (hadSlashCommandQuery || hasSlashCommandQuery) {
    requestRender();
  }
}

function handleModelSearchInput(event: Event) {
  state.modelSearch = (event.target as HTMLInputElement).value;
  requestInputRender();
}



function applySlashCommandSelection(command: ApiSlashCommand) {
  state.composerText = `/${command.name} `;
  state.selectedSlashCommandIndex = 0;
  requestRender();
  focusComposerInput();
}

function moveSelectedSlashCommand(delta: number) {
  const visibleSlashCommands = getVisibleSlashCommands();
  if (visibleSlashCommands.length === 0) {
    return;
  }

  state.selectedSlashCommandIndex =
    (state.selectedSlashCommandIndex + delta + visibleSlashCommands.length) % visibleSlashCommands.length;
  requestRender();
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
        requestRender();
      }
      return true;
    }
    case "copy": {
      const lastAssistantMessage = [...activeSession.messages].reverse().find((message) => message.role === "assistant");
      if (!lastAssistantMessage?.text.trim()) {
        state.error = "No assistant message is available to copy yet.";
        requestRender();
        return true;
      }
      await navigator.clipboard.writeText(lastAssistantMessage.text);
      state.info = "Copied the last assistant message.";
      requestRender();
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
        requestRender();
      }
      return true;
    }
    case "resume":
      state.sidebarOpen = true;
      state.showMenu = false;
      state.info = "Pick a session from the sidebar to resume it.";
      requestRender();
      focusComposerInput();
      return true;
    case "session": {
      const modelLabel = activeSession.model ? `${activeSession.model.provider}/${activeSession.model.id}` : "No model";
      state.info = `${activeSession.title} · ${activeSession.messages.length} msgs · ${modelLabel}`;
      requestRender();
      return true;
    }
    case "settings":
      state.showMenu = true;
      requestRender();
      return true;
    default:
      state.error = `/${commandName} is not available in Pi Web yet.`;
      requestRender();
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
    requestRender();
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

function getVisibleConversationMessages(messages: ApiSessionSnapshot["messages"]) {
  if (messages.length <= visibleMessageWindow) {
    return { messages, hiddenCount: 0 };
  }

  let startIndex = Math.max(0, messages.length - visibleMessageWindow);
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!candidate) {
      continue;
    }
    if (!isUserPromptMessage(candidate)) {
      continue;
    }

    startIndex = index;
    break;
  }

  return {
    messages: messages.slice(startIndex),
    hiddenCount: startIndex,
  };
}

function showEarlierMessages() {
  visibleMessageWindow += MESSAGE_WINDOW_STEP;
  requestRender();
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

function getMessagesContainer() {
  return messagesContainer ?? document.querySelector<HTMLElement>(".pp-messages") ?? null;
}

function isNearMessagesBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= AUTO_SCROLL_NEAR_BOTTOM_THRESHOLD_PX;
}

function shouldAutoScroll() {
  if (scrollToBottomForceRequested) return true;
  const element = getMessagesContainer();
  if (!element) return followLatestMessages;
  return followLatestMessages || isNearMessagesBottom(element);
}

function updateFollowLatestMessages() {
  const element = getMessagesContainer();
  if (!element) return;
  followLatestMessages = isNearMessagesBottom(element);
}

function handleMessagesScroll() {
  updateFollowLatestMessages();
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

function scrollToBottom(options: { force?: boolean } = {}) {
  if (options.force) {
    scrollToBottomForceRequested = true;
  }
  if (!shouldAutoScroll()) {
    scrollToBottomForceRequested = false;
    return;
  }
  if (scrollToBottomRequested) return;
  scrollToBottomRequested = true;
  requestAnimationFrame(() => {
    scrollToBottomRequested = false;
    const el = getMessagesContainer();
    if (el) {
      el.scrollTop = el.scrollHeight;
      followLatestMessages = true;
    }
    scrollToBottomForceRequested = false;
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

function formatContextUsage(contextUsage: ApiSessionSnapshot["contextUsage"]) {
  if (!contextUsage) return undefined;
  const roundedPercent = contextUsage.percent >= 10
    ? Math.round(contextUsage.percent)
    : Math.round(contextUsage.percent * 10) / 10;
  return `${roundedPercent}% context`;
}

function shortenCwd(cwd: string): string {
  const home = "/Users/kpovolotskyy";
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~/" + cwd.slice(home.length + 1);
  return cwd;
}

function truncate(text: string, maxLength: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}\u2026`;
}

function getActiveSessionListItem() {
  const activeSession = state.activeSession;
  if (!activeSession) return undefined;
  return state.sessions.find((session) =>
    session.id === activeSession.sessionId
    || (activeSession.sessionFile && session.sessionFile === activeSession.sessionFile),
  );
}

function getSessionDirectoryOverride(session: Pick<ApiSessionSnapshot, "sessionId" | "sessionFile">) {
  return sessionDirectoryOverrides.get(session.sessionId)
    ?? (session.sessionFile ? sessionDirectoryOverrides.get(session.sessionFile) : undefined);
}

function setSessionDirectoryOverride(session: Pick<ApiSessionSnapshot, "sessionId" | "sessionFile">, cwd: string) {
  sessionDirectoryOverrides.set(session.sessionId, cwd);
  if (session.sessionFile) {
    sessionDirectoryOverrides.set(session.sessionFile, cwd);
  }
}



async function getMessageActionTargetFromContext(context: MessageActionContext) {
  const activeSession = state.activeSession;
  if (!activeSession) {
    return undefined;
  }

  const sessionId = activeSession.sessionId;
  const response = await apiGet<{ messages: ApiTreeMessage[] }>(`/api/sessions/${sessionId}/tree-messages`);
  if (state.activeSession?.sessionId !== sessionId) {
    return undefined;
  }

  const currentPathPrompts = response.messages
    .filter((message) => message.isOnCurrentPath)
    .reverse();
  const matchingPrompt = currentPathPrompts[context.promptOrdinal];

  return {
    entryId: matchingPrompt?.entryId ?? context.promptMessage.id,
    promptText: matchingPrompt?.text ?? context.promptMessage.text,
    promptMessage: context.promptMessage,
    selectedMessage: context.selectedMessage,
    usesNearestPrompt: context.usesNearestPrompt,
  };
}

function handleMessageCopy(messageText: string, event: Event) {
  const button = event.currentTarget;
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  copyMessageText(messageText, button);
}

async function handleMessageEdit(context: MessageActionContext | undefined) {
  try {
    const target = context ? await getMessageActionTargetFromContext(context) : undefined;
    if (!target) {
      state.error = "No earlier prompt is available to edit yet.";
      requestRender();
      return;
    }

    await forkFromEntry(target.entryId, {
      composerMode: "prompt",
      focusComposer: true,
      info: target.usesNearestPrompt
        ? "Edit opened a safe fork from the nearest prompt. Update the copied prompt and send when ready."
        : "Edit opened a safe fork from this prompt. Update the copied prompt and send when ready.",
    });
  } catch (error) {
    state.error = getErrorMessage(error);
    requestRender();
  }
}

async function handleMessageForkFromHere(context: MessageActionContext | undefined) {
  try {
    const target = context ? await getMessageActionTargetFromContext(context) : undefined;
    if (!target) {
      state.error = "No earlier prompt is available to fork from yet.";
      requestRender();
      return;
    }

    await forkFromEntry(target.entryId, {
      composerMode: "prompt",
      focusComposer: true,
      info: target.usesNearestPrompt
        ? "Fork created from the nearest prompt. The copied prompt is ready in the composer."
        : "Fork created from this prompt. The copied prompt is ready in the composer.",
    });
  } catch (error) {
    state.error = getErrorMessage(error);
    requestRender();
  }
}

async function handleMessageRetry(context: MessageActionContext | undefined) {
  try {
    const target = context ? await getMessageActionTargetFromContext(context) : undefined;
    if (!target) {
      state.error = "No earlier prompt is available to retry yet.";
      requestRender();
      return;
    }

    const forkResponse = await forkFromEntry(target.entryId, {
      composerMode: "prompt",
    });
    if (!forkResponse || forkResponse.cancelled) {
      return;
    }

    if (!target.promptText.trim()) {
      state.error = "The selected prompt is empty, so there is nothing to retry.";
      requestRender();
      return;
    }

    if (state.activeSession?.sessionId !== forkResponse.snapshot.sessionId) {
      return;
    }

    await sendComposer();
    if (!state.error) {
      state.info = target.usesNearestPrompt
        ? "Retry sent in a new fork from the nearest prompt."
        : "Retry sent in a new fork from this prompt.";
      requestRender();
    }
  } catch (error) {
    state.error = getErrorMessage(error);
    requestRender();
  }
}

function handleAppClick(event: Event) {
  handleCodeCopyClick(event);
}

function setupAppInteractions() {
  document.getElementById("app")?.addEventListener("click", handleAppClick);
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

async function handleSessionClick(session: ApiSessionListItem) {
  if (state.switchingSessionId === session.id) return;
  if (
    state.activeSession?.sessionId === session.id
    && session.live
    && state.liveConnectionState !== "reconnecting"
    && state.liveConnectionState !== "disconnected"
  ) {
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
  requestRender();
  await waitForNextPaint();
  await delay(SESSION_SWITCH_FEEDBACK_MS);

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
      requestRender();
    }
  }
}

function removeAttachment(id: string) {
  state.attachments = state.attachments.filter((a) => a.id !== id);
  requestRender();
}

/* ─── Render ─── */

function requestRender() {
  if (!appRoot || renderRequested) return;
  renderRequested = true;
  requestAnimationFrame(() => {
    renderRequested = false;
    render(template(), appRoot);
    const previousMessagesContainer = messagesContainer;
    const nextMessagesContainer = document.querySelector<HTMLElement>(".pp-messages");

    if (previousMessagesContainer !== nextMessagesContainer) {
      previousMessagesContainer?.removeEventListener("scroll", handleMessagesScroll);
      nextMessagesContainer?.addEventListener("scroll", handleMessagesScroll, { passive: true });
      messagesContainer = nextMessagesContainer;
    } else {
      messagesContainer = nextMessagesContainer;
    }

    updateFollowLatestMessages();
    scheduleExtensionLayoutSync();
  });
}

function renderMessageActions(
  message: ApiSessionSnapshot["messages"][number],
  messageActionContext: MessageActionContext | undefined,
  copyText: string = message.text,
) {
  const canReplayPrompt = Boolean(messageActionContext);
  const replayTitle = messageActionContext?.usesNearestPrompt
    ? "Use the nearest earlier prompt for this action"
    : "Use this prompt for this action";

  return html`
    <details class="pp-message-actions">
      <summary class="pp-message-actions-toggle" title="Message actions" aria-label="Message actions">\u22ef</summary>
      <div class="pp-message-actions-menu" role="group" aria-label="Message actions">
      <button
        class="pp-message-action-btn"
        type="button"
        @click=${(event: Event) => handleMessageCopy(copyText, event)}
        aria-label="Copy message"
      >Copy</button>
      <button
        class="pp-message-action-btn"
        type="button"
        ?disabled=${!canReplayPrompt}
        title=${replayTitle}
        @click=${() => void handleMessageRetry(messageActionContext)}
        aria-label="Retry from here"
      >Retry</button>
      <button
        class="pp-message-action-btn"
        type="button"
        ?disabled=${!canReplayPrompt}
        title=${replayTitle}
        @click=${() => void handleMessageEdit(messageActionContext)}
        aria-label="Edit prompt from here"
      >Edit</button>
      <button
        class="pp-message-action-btn"
        type="button"
        ?disabled=${!canReplayPrompt}
        title=${replayTitle}
        @click=${() => void handleMessageForkFromHere(messageActionContext)}
        aria-label="Fork from here"
      >Fork</button>
      </div>
    </details>
  `;
}


function handleToolCardToggle(cardKey: string, event: Event) {
  const details = event.currentTarget;
  if (details instanceof HTMLDetailsElement) {
    if (details.open) {
      state.expandedToolCards.add(cardKey);
    } else {
      state.expandedToolCards.delete(cardKey);
    }
    requestRender();
  }
}

function getConversationRenderingOptions(actionContextMessages: ApiSessionSnapshot["messages"]) {
  return {
    sessionId: state.activeSession?.sessionId,
    actionContextMessages,
    expandedToolCards: state.expandedToolCards,
    onToolCardToggle: handleToolCardToggle,
    renderMessageActions,
  };
}



const template = () => {
  const renderedMessages = state.activeSession ? getRenderedMessages(state.activeSession) : [];
  const visibleConversation = getVisibleConversationMessages(renderedMessages);
  const conversationRendering = getConversationRenderingOptions(renderedMessages);
  const conversation = state.activeSession
    ? renderConversation(visibleConversation.messages, state.activeSession.toolExecutions, conversationRendering)
    : undefined;
  const detachedToolExecutions = conversation?.remainingToolExecutions.filter((tool) => tool.status !== "done") ?? [];
  const activeSessionListItem = getActiveSessionListItem();
  const sessionCwd = state.activeSession
    ? activeSessionListItem?.cwd ?? getSessionDirectoryOverride(state.activeSession)
    : undefined;
  const workspaceLabel = sessionCwd ? shortenCwd(sessionCwd) : undefined;
  const contextUsageLabel = formatContextUsage(state.activeSession?.contextUsage);
  const runningToolCount = state.activeSession?.toolExecutions.filter((tool) => tool.status === "running").length ?? 0;
  const lastMessage = state.activeSession?.messages.at(-1);
  const isReasoning = state.activeSession?.status === "streaming"
    && runningToolCount === 0
    && lastMessage?.role === "assistant"
    && Array.isArray(lastMessage.parts)
    && lastMessage.parts.at(-1)?.type === "thinking";
  const activeSessionModelLabel = state.activeSession?.model?.name ?? "No model";

  return html`
  <div class="pp-shell pp-shell-${state.displayMode}" data-display-mode=${state.displayMode}>
    ${extensionUi.renderToasts()}

    <!-- Header -->
    <header class="pp-header">
      <div class="pp-header-left">
        <button
          class="pp-header-icon-btn"
          @click=${toggleSidebar}
          aria-label=${state.sidebarOpen ? isMobileSidebarLayout() ? "Close sidebar" : "Collapse sidebar" : isMobileSidebarLayout() ? "Expand sidebar" : "Show session list"}
          aria-expanded=${String(state.sidebarOpen)}
        >\u2630</button>
        <span class="pp-header-title pp-header-wordmark">Pi Web</span>
        ${state.activeSession
          ? html`<span class="pp-header-title pp-header-session-title" title=${state.activeSession.title}>${state.activeSession.title}</span>`
          : nothing}
      </div>
      <div class="pp-header-right">
        <button
          class="pp-header-new-btn"
          @click=${handleCreateSession}
        >+ NEW</button>
        <button
          class="pp-header-new-btn"
          @click=${openProjectSessionDialog}
        >PROJECT</button>
        <div class="pp-header-menu-wrap">
          <button
            class="pp-header-icon-btn"
            @click=${() => { state.showMenu = !state.showMenu; requestRender(); }}
            aria-label="Menu"
            aria-expanded=${String(state.showMenu)}
          >⋯</button>
          ${state.showMenu ? renderMenu() : nothing}
        </div>
      </div>
    </header>

    <!-- Body -->
    <div class="pp-body ${state.sidebarOpen ? "sidebar-open" : "sidebar-closed"} ${isMobileSidebarLayout() ? "sidebar-overlay" : "sidebar-docked"}">
      ${isMobileSidebarLayout() && state.sidebarOpen
        ? html`<button class="pp-sidebar-scrim" @click=${closeSidebar} aria-label="Dismiss sidebar overlay"></button>`
        : nothing}
      <!-- Sidebar -->
      <aside class="pp-sidebar ${isMobileSidebarLayout() ? "mobile" : "desktop"}" aria-hidden=${String(!state.sidebarOpen)}>
        <div class="pp-sidebar-search">
          <input
            type="text"
            placeholder="Search sessions\u2026"
            .value=${state.sessionsSearch}
            @input=${handleSessionsSearchInput}
          />
        </div>
        <div class="pp-sidebar-list">
          ${renderSidebarSessions()}
        </div>
      </aside>

      <!-- Main content -->
      <main class="pp-main" aria-label="Active conversation">
        ${state.activeSession
          ? html`
              <div class="pp-active-session-header">
                <div class="pp-active-session-title-block">
                  <h1>${state.activeSession.title}</h1>
                  <div class="pp-active-session-meta">
                    ${state.activeSession.messages.length} msgs · ${activeSessionModelLabel}
                  </div>
                </div>
              </div>
            `
          : nothing}
        ${state.activeSession?.externallyDirty ? renderExternalBanner() : nothing}

        ${state.error ? html`<div class="pp-error" style="margin:0.75rem 1.5rem 0;">${state.error}</div>` : nothing}
        ${state.info ? html`<div class="pp-info" style="margin:0.75rem 1.5rem 0;">${state.info}</div>` : nothing}
        ${extensionUi.renderHeader()}

        <div class="pp-messages">
          <div class="pp-messages-inner">
            ${!state.isLoading && visibleConversation.hiddenCount > 0
              ? html`
                  <div class="pp-conversation-window">
                    <button class="pp-conversation-window-btn" @click=${showEarlierMessages}>
                      Show ${Math.min(MESSAGE_WINDOW_STEP, visibleConversation.hiddenCount)} earlier message${Math.min(MESSAGE_WINDOW_STEP, visibleConversation.hiddenCount) === 1 ? "" : "s"}
                    </button>
                    <span class="pp-conversation-window-meta">${visibleConversation.hiddenCount} hidden</span>
                  </div>
                `
              : nothing}

            ${state.isLoading
              ? renderSkeleton()
              : state.activeSession && renderedMessages.length
                ? conversation?.entries
                : html`<div class="pp-empty">No messages yet. Start typing below.</div>`}

            ${detachedToolExecutions.length
              ? detachedToolExecutions.map((tool) => renderToolCard(conversationRendering, tool))
              : nothing}

            ${state.activeSession?.status === "streaming"
              ? html`<div style="margin-bottom:0.5rem;"><span class="pp-streaming-cursor"></span></div>`
              : nothing}
          </div>
        </div>

        ${extensionUi.renderWidgets("aboveEditor")}

        ${state.activeSession?.status === "streaming"
          ? html`
              <div class="pp-session-activity-shell">
                <div class="pp-session-activity">
                  <span class="pp-session-activity-dot" aria-hidden="true"></span>
                  <span class="pp-session-activity-text">
                    ${isReasoning ? "Thinking…" : "Agent working…"}
                    ${runningToolCount > 0
                      ? ` ${runningToolCount} tool${runningToolCount === 1 ? "" : "s"} running.`
                      : ""}
                  </span>
                </div>
              </div>
            `
          : nothing}

        <!-- Composer -->
        <div class="pp-composer-shell">
          ${renderSlashCommandPalette()}
          <div class="pp-composer">
            ${(() => {
              const isComposerDisabled = state.isLoading || Boolean(state.switchingSessionId) || !state.activeSession;
              return html`
                <label class="pp-composer-attach" title="Attach images">
                  📎
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    ?disabled=${isComposerDisabled}
                    @change=${(e: Event) => handleFiles((e.target as HTMLInputElement).files)}
                  />
                </label>
                ${state.attachments.length ? renderAttachmentsRow() : nothing}
                <textarea
                  class="pp-composer-input"
                  rows="1"
                  placeholder=${getComposerPlaceholder(state.composerMode)}
                  .value=${live(state.composerText)}
                  ?disabled=${isComposerDisabled}
                  @input=${handleComposerInput}
                  @paste=${(e: ClipboardEvent) => {
                    void handleComposerPaste(e);
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
                    >■</button>`
                  : html`<button
                      class="pp-composer-btn"
                      @click=${() => void sendComposer()}
                      title="Send"
                      ?disabled=${isComposerDisabled || state.isSubmittingComposer}
                    >➤</button>`}
              `;
            })()}
          </div>
        </div>

        ${extensionUi.renderWidgets("belowEditor")}

        ${extensionUi.hasFooter()
          ? extensionUi.renderFooter()
          : html`
              <!-- Status bar -->
              <div class="pp-statusbar">
                <div class="pp-statusbar-meta">
                  ${workspaceLabel
                    ? html`<span class="pp-statusbar-detail" title=${sessionCwd}>${workspaceLabel}</span>`
                    : nothing}
                  ${contextUsageLabel && state.activeSession?.contextUsage
                    ? html`
                        <span
                          class="pp-statusbar-detail"
                          title=${`${state.activeSession.contextUsage.tokens.toLocaleString()} / ${state.activeSession.contextUsage.contextWindow.toLocaleString()} tokens`}
                        >${contextUsageLabel}</span>
                      `
                    : nothing}
                </div>
                <div class="pp-statusbar-actions">
                  ${extensionUi.renderStatuses()}
                  <button class="pp-statusbar-model" @click=${openModelsDialog}>
                    ${activeSessionModelLabel}
                  </button>
                  <button
                    class="pp-statusbar-model"
                    @click=${openThinkingLevelsDialog}
                    title="Select thinking level"
                    aria-label=${`Thinking level: ${formatThinkingLevel(state.activeSession?.thinkingLevel)}`}
                  >
                    \ud83d\udca1 ${formatThinkingLevel(state.activeSession?.thinkingLevel)}
                  </button>
                </div>
              </div>
            `}
      </main>
    </div>

    <!-- Dialogs -->
    ${projectSessionDialog.render()}
    ${state.showModels ? renderModelsDialog() : nothing}
    ${state.showThinkingLevels ? renderThinkingLevelsDialog() : nothing}
    ${state.showActions ? renderActionsDialog() : nothing}
    ${extensionUi.renderDialog()}
  </div>
`;
};

/* ─── Sidebar rendering ─── */

function renderSidebarSessions() {
  const visible = getVisibleSessions();
  if (visible.length === 0) {
    return html`<div style="padding:1rem 0.75rem;font-size:0.8125rem;color:var(--pp-text-muted);">No sessions match.</div>`;
  }

  return html`${visible.map((session) => renderSidebarItem(session))}`;
}

function renderSidebarItem(session: ApiSessionListItem) {
  const isSwitching = state.switchingSessionId === session.id;
  const isActive = state.switchingSessionId
    ? isSwitching
    : state.activeSession?.sessionId === session.id;
  const statusClass = session.status === "streaming"
    ? "working"
    : session.live
      ? "live"
      : "idle";
  return html`
    <button
      class="pp-session-item ${isActive ? "active" : ""} ${isSwitching ? "loading" : ""}"
      @click=${() => handleSessionClick(session)}
      ?disabled=${isSwitching}
      aria-busy=${String(isSwitching)}
    >
      <div class="pp-session-dot ${statusClass}"></div>
      <div class="pp-session-info">
        <div class="pp-session-title-row">
          <div class="pp-session-title">${truncate(session.title, 60)}</div>
          ${session.status === "streaming"
            ? html`<span class="pp-session-status-chip">Working</span>`
            : nothing}
        </div>
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



/* ─── Menu dropdown ─── */

function renderMenu() {
  return html`
    <div class="pp-menu-overlay" @click=${() => { state.showMenu = false; requestRender(); }}></div>
    <div class="pp-menu" @click=${(e: Event) => e.stopPropagation()}>
      ${state.activeSession
        ? html`
            <div class="pp-menu-section">Session</div>
            <button class="pp-menu-item" @click=${openActions}>
              \u2699\ufe0f Session actions
            </button>
            <div class="pp-menu-divider"></div>
          `
        : nothing}
      <div class="pp-menu-section">Settings</div>
      <button class="pp-menu-item" @click=${toggleTokenUsage}>
        $ Token usage ${state.showTokenUsage ? html`<span class="check">\u2713</span>` : nothing}
      </button>
      <div class="pp-menu-divider"></div>
      <div class="pp-menu-section">Display</div>
      <button class="pp-menu-item" @click=${() => setDisplayMode("default")}>
        Default ${state.displayMode === "default" ? html`<span class="check">\u2713</span>` : nothing}
      </button>
      <button class="pp-menu-item" @click=${() => setDisplayMode("dense")}>
        Dense / CLI ${state.displayMode === "dense" ? html`<span class="check">\u2713</span>` : nothing}
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
        (attachment) => html`
          <div class="pp-attachment-pill">
            <span class="pp-attachment-icon" aria-hidden="true">IMG</span>
            <span class="pp-attachment-name" title=${attachment.fileName}>${attachment.fileName}</span>
            <button
              class="pp-attachment-remove"
              @click=${() => removeAttachment(attachment.id)}
              title="Remove attachment"
              aria-label=${`Remove ${attachment.fileName}`}
            >\u00d7</button>
          </div>
        `,
      )}
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
    <div class="pp-dialog-overlay" @click=${() => { state.showModels = false; requestRender(); }}>
      <div class="pp-dialog" @click=${(e: Event) => e.stopPropagation()}>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
          <div class="pp-dialog-title">Models</div>
          <div style="display:flex;gap:0.375rem;">
            <button class="pp-dialog-btn" @click=${cycleModel}>Cycle</button>
            <button class="pp-dialog-btn" @click=${() => { state.showModels = false; requestRender(); }}>Done</button>
          </div>
        </div>
        <input
          class="pp-dialog-input"
          style="margin-bottom:0.5rem;"
          .value=${live(state.modelSearch)}
          @input=${handleModelSearchInput}
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

function renderThinkingLevelsDialog() {
  const visibleLevels = getVisibleThinkingLevels();
  const currentLevel = state.activeSession?.thinkingLevel;

  return html`
    <div class="pp-dialog-overlay" @click=${() => { state.showThinkingLevels = false; requestRender(); }}>
      <div class="pp-dialog" @click=${(e: Event) => e.stopPropagation()}>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
          <div class="pp-dialog-title">Thinking level</div>
          <button class="pp-dialog-btn" @click=${() => { state.showThinkingLevels = false; requestRender(); }}>Done</button>
        </div>
        <div class="pp-dialog-subtitle">
          Choose how much reasoning the current session should request from the model.
        </div>
        ${visibleLevels.map((level) => {
          const isCurrent = level === currentLevel;
          const dialogLabel = level === "xhigh" ? "Maximum thinking" : formatThinkingLevel(level);
          return html`
            <button
              class="pp-dialog-item"
              aria-label=${isCurrent ? `${dialogLabel} Current` : dialogLabel}
              @click=${() => void setThinkingLevel(level)}
            >
              <div class="pp-dialog-item-header">
                <div class="pp-dialog-item-title">${formatThinkingLevel(level)}</div>
                <div class="pp-dialog-item-badges">
                  ${isCurrent ? html`<span class="pp-dialog-item-badge current">Current</span>` : nothing}
                </div>
              </div>
              <div class="pp-dialog-item-desc">${String(level)}</div>
            </button>
          `;
        })}
      </div>
    </div>
  `;
}

/* ─── Actions dialog ─── */

function renderActionsDialog() {
  return html`
    <div class="pp-dialog-overlay" @click=${() => { state.showActions = false; requestRender(); }}>
      <div class="pp-dialog" @click=${(e: Event) => e.stopPropagation()}>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;">
          <div class="pp-dialog-title">Session actions</div>
          <button class="pp-dialog-btn" @click=${() => { state.showActions = false; requestRender(); }}>Done</button>
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

window.addEventListener("resize", scheduleExtensionLayoutSync, { passive: true });

setupAppInteractions();
await bootstrap();
