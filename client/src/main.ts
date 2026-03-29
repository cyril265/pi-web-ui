import { html, render, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
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
  ApiSessionPatch,
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
type ParsedToolCallMessage = {
  toolName: string;
  toolCallId: string | undefined;
  arguments: unknown;
  preview: string | undefined;
};
type AssistantMessagePart =
  | { type: "markdown"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; toolCall: ParsedToolCallMessage };
type ToolResultMessage = Pick<ApiSessionSnapshot["messages"][number], "text" | "isError" | "toolCallId">;
type ToolActivityState = "call" | ApiSessionSnapshot["toolExecutions"][number]["status"];
type ConversationRenderResult = {
  entries: ReturnType<typeof html>[];
  remainingToolExecutions: ApiSessionSnapshot["toolExecutions"];
};
type LiveConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";
type ApiRequestOptions = {
  signal?: AbortSignal;
};
type SessionSelection = {
  token: number;
  signal: AbortSignal;
};
type UserPromptMessage = ApiSessionSnapshot["messages"][number] & {
  role: "user" | "user-with-attachments";
};
type MessageActionContext = {
  promptMessage: ApiSessionSnapshot["messages"][number];
  promptOrdinal: number;
  selectedMessage: ApiSessionSnapshot["messages"][number];
  usesNearestPrompt: boolean;
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
  showThinkingLevels: boolean;
  showActions: boolean;
  showCreateProjectDialog: boolean;
  newProjectPath: string;
  newProjectError: string | undefined;
  isPickingProjectDirectory: boolean;
  isCreatingProjectSession: boolean;
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
const RECENT_MODELS_LIMIT = 8;
const MAX_VISIBLE_SLASH_COMMANDS = 8;
const FILTER_INPUT_RENDER_DELAY_MS = 100;
const AUTO_SCROLL_NEAR_BOTTOM_THRESHOLD_PX = 64;
const sidebarMediaQuery = window.matchMedia(MOBILE_SIDEBAR_MEDIA_QUERY);
const appRoot = document.getElementById("app");

function loadRecentModelKeys() {
  return (localStorage.getItem(RECENT_MODELS_STORAGE_KEY) ?? "")
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
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
  showThinkingLevels: false,
  showActions: false,
  showCreateProjectDialog: false,
  newProjectPath: "",
  newProjectError: undefined,
  isPickingProjectDirectory: false,
  isCreatingProjectSession: false,
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
let currentSessionSelection = 0;
let currentSessionSelectionController = new AbortController();
let eventReconnectTimeout: ReturnType<typeof setTimeout> | undefined;
let eventReconnectAttempts = 0;
let sessionsLoadRequestId = 0;
let slashCommandsLoadRequestId = 0;
const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
let messagesContainer: HTMLElement | null = null;
let renderRequested = false;
let followLatestMessages = true;
let scrollToBottomRequested = false;
let scrollToBottomForceRequested = false;
const emptyMessageActionContexts = new Map<string, MessageActionContext>();
let cachedMessageActionContextSource: ApiSessionSnapshot["messages"] | undefined;
let cachedMessageActionContexts = emptyMessageActionContexts;
const EVENT_RECONNECT_BASE_DELAY_MS = 1_000;
const EVENT_RECONNECT_MAX_DELAY_MS = 10_000;
const THINKING_START_MARKER = "<<<pi-thinking>>>";
const THINKING_END_MARKER = "<<<pi-thinking-end>>>";
const assistantMessagePartsCache = new Map<string, AssistantMessagePart[]>();
const markdownHtmlCache = new Map<string, string>();
const codeBlockCopyCache = new Map<string, string>();
let codeBlockCopyId = 0;
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

const HIGHLIGHT_LANGUAGE_ALIASES: Record<string, string> = {
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  css: "css",
  diff: "diff",
  patch: "diff",
  javascript: "javascript",
  js: "javascript",
  jsx: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  json: "json",
  jsonc: "json",
  markdown: "markdown",
  md: "markdown",
  plaintext: "plaintext",
  text: "plaintext",
  txt: "plaintext",
  python: "python",
  py: "python",
  typescript: "typescript",
  ts: "typescript",
  tsx: "typescript",
  html: "xml",
  xml: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const CODE_LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  css: "CSS",
  diff: "Diff",
  javascript: "JavaScript",
  json: "JSON",
  markdown: "Markdown",
  plaintext: "Text",
  python: "Python",
  typescript: "TypeScript",
  xml: "HTML",
  yaml: "YAML",
};

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

([
  ["bash", bash],
  ["css", css],
  ["diff", diff],
  ["javascript", javascript],
  ["json", json],
  ["markdown", markdown],
  ["plaintext", plaintext],
  ["python", python],
  ["typescript", typescript],
  ["xml", xml],
  ["yaml", yaml],
] as const).forEach(([language, definition]) => hljs.registerLanguage(language, definition));

marked.use({
  renderer: {
    code({ text, lang }) {
      return `${renderMarkdownCodeBlock(text, lang)}\n`;
    },
    table(token) {
      let header = "";
      for (const cell of token.header) {
        header += this.tablecell(cell);
      }

      const head = this.tablerow({ text: header });
      let rows = "";
      for (const row of token.rows) {
        let body = "";
        for (const cell of row) {
          body += this.tablecell(cell);
        }
        rows += this.tablerow({ text: body });
      }

      return `<div class="pp-table-scroll"><table>
<thead>
${head}</thead>
${rows ? `<tbody>${rows}</tbody>` : ""}</table></div>
`;
    },
  },
});

marked.setOptions({ breaks: true, gfm: true });

/* ─── API / state logic ─── */

async function bootstrap() {
  applyTheme();
  applyDisplayMode();
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

function openCreateProjectDialog() {
  state.showMenu = false;
  state.showCreateProjectDialog = true;
  state.newProjectPath = getActiveSessionListItem()?.cwd ?? state.newProjectPath;
  state.newProjectError = undefined;
  requestRender();
}

function closeCreateProjectDialog() {
  if (state.isPickingProjectDirectory || state.isCreatingProjectSession) {
    return;
  }
  state.showCreateProjectDialog = false;
  state.newProjectError = undefined;
  requestRender();
}

async function pickProjectDirectory() {
  state.newProjectError = undefined;
  state.isPickingProjectDirectory = true;
  requestRender();

  try {
    const response = await apiPost<{ cancelled: boolean; path?: string }>("/api/directories/select", {
      initialPath: state.newProjectPath.trim() || getActiveSessionListItem()?.cwd,
    });
    if (response.path) {
      state.newProjectPath = response.path;
    }
  } catch (error) {
    state.newProjectError = getErrorMessage(error);
  } finally {
    state.isPickingProjectDirectory = false;
    requestRender();
  }
}

async function createProjectSession() {
  const projectPath = state.newProjectPath.trim();
  if (!projectPath) {
    state.newProjectError = "Project directory is required.";
    requestRender();
    return;
  }

  state.newProjectError = undefined;
  state.isCreatingProjectSession = true;
  requestRender();

  try {
    const opened = await createSession(projectPath);
    if (!opened || !state.activeSession) {
      return;
    }

    setSessionDirectoryOverride(state.activeSession, projectPath);

    const activeSessionListItem = getActiveSessionListItem();
    if (activeSessionListItem) {
      activeSessionListItem.cwd = projectPath;
    }

    state.showCreateProjectDialog = false;
    closeSidebarIfMobile();
  } catch (error) {
    if (!isAbortError(error)) {
      state.newProjectError = getErrorMessage(error);
    }
  } finally {
    state.isCreatingProjectSession = false;
    requestRender();
  }
}

function handleCreateProjectPathKeyDown(event: KeyboardEvent) {
  if (event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  void createProjectSession();
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
  if (!state.activeSession) return;
  await apiPost(`/api/sessions/${state.activeSession.sessionId}/thinking-level`, { thinkingLevel: level });
  state.showThinkingLevels = false;
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

  const { loadAttachment } = await import("@mariozechner/pi-web-ui");
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

function clearRenderedMessageCaches() {
  assistantMessagePartsCache.clear();
  markdownHtmlCache.clear();
  codeBlockCopyCache.clear();
  clearMessageActionContextCache();
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

function syncSessionListItem(snapshot: ApiSessionSnapshot, options: { touchLastModified?: boolean } = {}) {
  const existing = state.sessions.find((session) =>
    session.id === snapshot.sessionId || (snapshot.sessionFile && session.sessionFile === snapshot.sessionFile),
  );
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
  clearMessageActionContextCache();
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
  syncSessionListItem(activeSession);
  return true;
}

function applySnapshot(snapshot: ApiSessionSnapshot, options: { resetSessionUi?: boolean } = {}) {
  const previousSessionId = state.activeSession?.sessionId;
  reconcilePendingComposerSubmissions(snapshot);
  state.activeSession = snapshot;
  clearMessageActionContextCache();
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
        state.pendingExtensionUi = event.request;
        state.extensionUiValue = event.request.prefill ?? "";
        break;
      case "extension_notify":
        pushExtensionNotification(event.notification);
        break;
      case "set_editor_text":
        state.composerText = event.text;
        break;
      case "set_status":
        setExtensionStatus(event.key, event.text);
        break;
      case "set_widget":
        setExtensionWidget(event.key, event.widget);
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

function setError(message: string) {
  state.error = message;
  requestRender();
}

function pushExtensionNotification(notification: ApiExtensionNotification) {
  state.extensionNotifications = [notification, ...state.extensionNotifications].slice(0, 4);
  setTimeout(() => {
    state.extensionNotifications = state.extensionNotifications.filter((e) => e.id !== notification.id);
    requestRender();
  }, 6_000).unref?.();
}

function setExtensionStatus(key: string, text: string | undefined) {
  state.extensionStatuses = text
    ? [{ key, text }, ...state.extensionStatuses.filter((e) => e.key !== key)]
    : state.extensionStatuses.filter((e) => e.key !== key);
}

function isExtensionWidgetPlacement(value: unknown): value is ApiExtensionWidget["placement"] {
  return value === "aboveEditor" || value === "belowEditor";
}

function normalizeExtensionWidgetLines(lines: unknown): string[] {
  if (typeof lines === "string") return [lines];
  if (!Array.isArray(lines)) return [];
  return lines.filter((line): line is string => typeof line === "string");
}

function normalizeExtensionWidget(key: string, widget: unknown): ApiExtensionWidget | undefined {
  if (widget == null) return undefined;
  if (typeof widget === "string") {
    return { key, lines: [widget], placement: "aboveEditor" };
  }
  if (!isRecord(widget)) return undefined;

  const linesSource = widget.lines ?? widget.content ?? widget.text;
  const lines = normalizeExtensionWidgetLines(linesSource);
  const hasRenderableLines =
    typeof linesSource === "string" || (Array.isArray(linesSource) && (linesSource.length === 0 || lines.length > 0));
  if (!hasRenderableLines) return undefined;

  return {
    key: typeof widget.key === "string" ? widget.key : key,
    lines,
    placement: isExtensionWidgetPlacement(widget.placement) ? widget.placement : "aboveEditor",
  };
}

function setExtensionWidget(key: string, widget: unknown) {
  const normalizedWidget = normalizeExtensionWidget(key, widget);
  state.extensionWidgets = normalizedWidget
    ? [normalizedWidget, ...state.extensionWidgets.filter((e) => e.key !== key)]
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
  requestRender();
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

function handleExtensionUiValueInput(event: Event) {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    state.extensionUiValue = target.value;
  }
}

function clearMessageActionContextCache() {
  cachedMessageActionContextSource = undefined;
  cachedMessageActionContexts = emptyMessageActionContexts;
}

function isUserPromptMessage(
  message: ApiSessionSnapshot["messages"][number] | undefined,
): message is UserPromptMessage {
  return message?.role === "user" || message?.role === "user-with-attachments";
}

function isOptimisticMessageId(messageId: string) {
  return messageId.startsWith("optimistic-user-");
}

function buildMessageActionContexts(messages: ApiSessionSnapshot["messages"]) {
  const contexts = new Map<string, MessageActionContext>();
  let latestPrompt: ApiSessionSnapshot["messages"][number] | undefined;
  let promptOrdinal = -1;

  for (const message of messages) {
    if (isOptimisticMessageId(message.id)) {
      continue;
    }

    if (isUserPromptMessage(message)) {
      latestPrompt = message;
      promptOrdinal += 1;
      contexts.set(message.id, {
        promptMessage: message,
        promptOrdinal,
        selectedMessage: message,
        usesNearestPrompt: false,
      });
      continue;
    }

    if (!latestPrompt) {
      continue;
    }

    contexts.set(message.id, {
      promptMessage: latestPrompt,
      promptOrdinal,
      selectedMessage: message,
      usesNearestPrompt: latestPrompt.id !== message.id,
    });
  }

  return contexts;
}

function getMessageActionContexts(messages: ApiSessionSnapshot["messages"]) {
  if (cachedMessageActionContextSource === messages) {
    return cachedMessageActionContexts;
  }

  cachedMessageActionContextSource = messages;
  cachedMessageActionContexts = buildMessageActionContexts(messages);
  return cachedMessageActionContexts;
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

function updateNewProjectPath(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  state.newProjectPath = target.value;
  state.newProjectError = undefined;
  requestRender();
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

function extractFenceLanguage(rawLanguage: string | undefined) {
  return rawLanguage?.trim().match(/^[^\s{]+/)?.[0]?.toLowerCase();
}

function getCodeLanguageInfo(rawLanguage: string | undefined) {
  const fenceLanguage = extractFenceLanguage(rawLanguage);
  if (!fenceLanguage) {
    return {
      displayLanguage: "Text",
      languageClass: "language-plaintext",
      normalizedLanguage: undefined,
      isDiff: false,
    };
  }

  const normalizedLanguage = HIGHLIGHT_LANGUAGE_ALIASES[fenceLanguage]
    ?? (hljs.getLanguage(fenceLanguage) ? fenceLanguage : undefined);
  const displayLanguage = normalizedLanguage
    ? (CODE_LANGUAGE_LABELS[normalizedLanguage] ?? fenceLanguage)
    : fenceLanguage;
  const classLanguage = normalizedLanguage ?? fenceLanguage;

  return {
    displayLanguage,
    languageClass: `language-${classLanguage.replace(/[^a-z0-9_-]+/g, "-")}`,
    normalizedLanguage,
    isDiff: normalizedLanguage === "diff",
  };
}

function createCodeBlockCopyId(text: string) {
  codeBlockCopyId += 1;
  const id = `code-block-${codeBlockCopyId}`;
  codeBlockCopyCache.set(id, text);
  return id;
}

function highlightCodeBlockText(text: string, language: string | undefined) {
  if (!language) {
    return escapeHtml(text);
  }

  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(text);
  }
}

function getDiffLineClassName(line: string) {
  if (
    line.startsWith("diff ")
    || line.startsWith("index ")
    || line.startsWith("+++ ")
    || line.startsWith("--- ")
    || line.startsWith("\\")
  ) {
    return "pp-code-line pp-diff-line pp-diff-line-meta";
  }
  if (line.startsWith("@@")) {
    return "pp-code-line pp-diff-line pp-diff-line-hunk";
  }
  if (line.startsWith("+")) {
    return "pp-code-line pp-diff-line pp-diff-line-add";
  }
  if (line.startsWith("-")) {
    return "pp-code-line pp-diff-line pp-diff-line-remove";
  }
  return "pp-code-line pp-diff-line pp-diff-line-context";
}

function renderDiffCodeHtml(text: string) {
  return text
    .split("\n")
    .map((line) => {
      const content = line.length > 0 ? escapeHtml(line) : "&#8203;";
      return `<span class="${getDiffLineClassName(line)}">${content}</span>`;
    })
    .join("");
}

function renderMarkdownCodeBlock(text: string, rawLanguage: string | undefined) {
  const { displayLanguage, languageClass, normalizedLanguage, isDiff } = getCodeLanguageInfo(rawLanguage);
  const copyId = createCodeBlockCopyId(text);
  const codeHtml = isDiff ? renderDiffCodeHtml(text) : highlightCodeBlockText(text, normalizedLanguage);

  return `<div class="pp-code-block pp-structured-block${isDiff ? " pp-code-block-diff" : ""}">
  <div class="pp-code-header">
    <span class="pp-code-language">${escapeHtml(displayLanguage)}</span>
    <button type="button" class="pp-copy-btn" data-copy-id="${copyId}">Copy</button>
  </div>
  <pre class="pp-code-surface"><code class="hljs ${languageClass}">${codeHtml}</code></pre>
</div>`;
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
    return html`<pre class="pp-content-block pp-structured-block pp-json-view">${unsafeHTML(highlightJson(prettyJson))}</pre>`;
  }

  return html`<pre class="pp-content-block pp-structured-block pp-tool-text">${formatted}</pre>`;
}

type ToolCallArgumentKind = "command" | "path" | "query" | "prompt" | "message" | "url";

function humanizeToolArgumentKey(key: string) {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return key;
  return normalized.replace(/\b\w/g, (match) => match.toUpperCase());
}

function getToolCallArgumentKind(key: string): ToolCallArgumentKind | undefined {
  const normalized = key.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "command" || normalized.endsWith("command")) return "command";
  if (normalized === "path" || normalized.endsWith("path")) return "path";
  if (normalized === "query" || normalized.endsWith("query")) return "query";
  if (normalized === "prompt" || normalized.endsWith("prompt")) return "prompt";
  if (normalized === "message" || normalized.endsWith("message")) return "message";
  if (normalized === "url" || normalized.endsWith("url")) return "url";
  return undefined;
}

function getToolCallArgumentPriority(kind: ToolCallArgumentKind) {
  switch (kind) {
    case "command":
      return 0;
    case "path":
      return 1;
    case "query":
      return 2;
    case "prompt":
      return 3;
    case "message":
      return 4;
    case "url":
      return 5;
    default:
      return Number.MAX_SAFE_INTEGER;
  }
}

function renderCopyableCodeBlock(options: {
  label: string;
  text: string;
  language?: string;
  className?: string;
}) {
  const { displayLanguage, languageClass, normalizedLanguage } = getCodeLanguageInfo(options.language);
  const copyId = createCodeBlockCopyId(options.text);
  const codeHtml = normalizedLanguage === "json"
    ? highlightJson(options.text)
    : highlightCodeBlockText(options.text, normalizedLanguage);
  const className = ["pp-code-block", "pp-structured-block", options.className].filter(Boolean).join(" ");
  const headerLabel = options.label || displayLanguage;

  return html`
    <div class=${className}>
      <div class="pp-code-header">
        <span class="pp-code-language">${headerLabel}</span>
        <button type="button" class="pp-copy-btn" data-copy-id=${copyId}>Copy</button>
      </div>
      <pre class="pp-code-surface">
        <code class="hljs ${languageClass}">${unsafeHTML(codeHtml)}</code>
      </pre>
    </div>
  `;
}

function formatToolCallMetadataValue(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return undefined;
}

function stringifyStructuredValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";

  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function renderToolCallArguments(argsValue: unknown) {
  const trimmed = stringifyStructuredValue(argsValue).trim();
  if (!trimmed) {
    return html`<span class="pp-tool-inline-note">No arguments</span>`;
  }

  const parsed = typeof argsValue === "string"
    ? tryParseJson(trimmed)
    : argsValue;
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    return renderStructuredBlock(trimmed);
  }

  const entries = Object.entries(parsed);
  const featuredEntries = entries
    .map(([key, value], index) => {
      if (typeof value !== "string" || !value.trim()) return undefined;
      const kind = getToolCallArgumentKind(key);
      if (!kind) return undefined;

      return {
        index,
        key,
        label: humanizeToolArgumentKey(key),
        kind,
        value,
      };
    })
    .filter((entry): entry is {
      index: number;
      key: string;
      label: string;
      kind: ToolCallArgumentKind;
      value: string;
    } => Boolean(entry))
    .sort((left, right) =>
      getToolCallArgumentPriority(left.kind) - getToolCallArgumentPriority(right.kind)
      || left.index - right.index
    );

  if (featuredEntries.length === 0) {
    return renderStructuredBlock(trimmed);
  }

  const featuredKeys = new Set(featuredEntries.map((entry) => entry.key));
  const metadataEntries = entries
    .map(([key, value]) => {
      if (featuredKeys.has(key)) return undefined;
      const formattedValue = formatToolCallMetadataValue(value);
      if (formattedValue === undefined) return undefined;

      return {
        key,
        label: humanizeToolArgumentKey(key),
        value: formattedValue,
      };
    })
    .filter((entry): entry is { key: string; label: string; value: string } => Boolean(entry));

  const rawJson = JSON.stringify(parsed, null, 2) ?? trimmed;

  return html`
    <div class="pp-tool-args">
      ${featuredEntries.map((entry) => renderCopyableCodeBlock({
        label: entry.label,
        text: entry.value,
        language: entry.kind === "command" ? "bash" : "plaintext",
        className: "pp-tool-arg-block",
      }))}
      ${metadataEntries.length > 0
        ? html`
            <div class="pp-tool-arg-meta">
              ${metadataEntries.map((entry) => html`
                <div class="pp-tool-arg-meta-item">
                  <span class="pp-tool-arg-meta-key">${entry.label}</span>
                  <code class="pp-tool-arg-meta-value">${entry.value}</code>
                </div>
              `)}
            </div>
          `
        : nothing}
      <details class="pp-tool-arg-raw">
        <summary class="pp-tool-arg-raw-summary">Raw JSON</summary>
        <div class="pp-tool-arg-raw-body">
          ${renderCopyableCodeBlock({
            label: "Raw JSON",
            text: rawJson,
            language: "json",
            className: "pp-tool-arg-block",
          })}
        </div>
      </details>
    </div>
  `;
}

function getToolCardKey(...parts: string[]) {
  return [state.activeSession?.sessionId ?? "no-session", ...parts].join(":");
}

function handleToolCardToggle(cardKey: string, event: Event) {
  const details = event.currentTarget;
  if (!(details instanceof HTMLDetailsElement)) return;

  if (details.open) state.expandedToolCards.add(cardKey);
  else state.expandedToolCards.delete(cardKey);

  requestRender();
}

function summarizeToolCallPreview(argsValue: unknown) {
  const trimmed = stringifyStructuredValue(argsValue).trim();
  if (!trimmed) return undefined;

  const parsed = typeof argsValue === "string"
    ? tryParseJson(trimmed)
    : argsValue;
  if (isRecord(parsed) && !Array.isArray(parsed)) {
    const preferredPreviewKeys = ["command", "path", "prompt", "message", "query"];
    for (const key of preferredPreviewKeys) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        return truncate(value, 60);
      }
    }
  }

  return truncate(trimmed.replace(/\s+/g, " "), 60);
}

function summarizeToolExecutionPreview(text: string) {
  const formatted = formatStructuredText(text)
    .replace(/\r\n/g, "\n")
    .trim();
  if (!formatted) return undefined;
  const firstMeaningfulLine = formatted
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return firstMeaningfulLine ? truncate(firstMeaningfulLine, 80) : undefined;
}

function isToolFailureText(text: string) {
  const formatted = formatStructuredText(text)
    .replace(/\r\n/g, "\n")
    .trim();
  if (!formatted) return false;

  const firstMeaningfulLine = formatted
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? formatted;

  if (/^error[:\s]/i.test(firstMeaningfulLine)) return true;

  return /\b(command not found|no such file or directory|not recognized as an internal or external command|permission denied|timed out|timeout|exception|traceback|failed|failure|ENOENT|EACCES|ECONNREFUSED|syntax error)\b/i
    .test(formatted);
}

function getToolResultState(
  resultMessage: ToolResultMessage,
  fallbackStatus: Extract<ToolActivityState, "done" | "error"> | undefined = undefined,
): Extract<ToolActivityState, "done" | "error"> {
  if (typeof resultMessage.isError === "boolean") {
    return resultMessage.isError ? "error" : "done";
  }

  if (fallbackStatus) {
    return fallbackStatus;
  }

  return isToolFailureText(resultMessage.text) ? "error" : "done";
}

function getToolActivityPreview(options: {
  toolCallPreview: string | undefined;
  resultMessages: ToolResultMessage[];
  toolExecution: ApiSessionSnapshot["toolExecutions"][number] | undefined;
  status: ToolActivityState;
}) {
  const resultPreview = [...options.resultMessages]
    .reverse()
    .map((resultMessage) => summarizeToolExecutionPreview(resultMessage.text))
    .find(Boolean);
  const executionPreview = summarizeToolExecutionPreview(options.toolExecution?.text ?? "");
  const outputPreview = resultPreview ?? executionPreview;

  if ((options.status === "running" || options.status === "done" || options.status === "error") && outputPreview) {
    return outputPreview;
  }

  return options.toolCallPreview ?? outputPreview;
}

function takeMatchingToolExecution(
  toolExecutions: ApiSessionSnapshot["toolExecutions"],
  toolCall: ParsedToolCallMessage,
  consumedToolExecutionIds: Set<string>,
) {
  if (toolCall.toolCallId) {
    const exactMatch = toolExecutions.find((toolExecution) =>
      toolExecution.toolCallId === toolCall.toolCallId && !consumedToolExecutionIds.has(toolExecution.toolCallId)
    );
    if (exactMatch) return exactMatch;
  }

  return toolExecutions.find((toolExecution) =>
    toolExecution.toolName === toolCall.toolName && !consumedToolExecutionIds.has(toolExecution.toolCallId)
  );
}

function getToolActivityState(
  toolExecution: ApiSessionSnapshot["toolExecutions"][number] | undefined,
  resultMessages: ToolResultMessage[],
): ToolActivityState {
  if (resultMessages.length > 0) {
    const explicitStatuses = resultMessages
      .filter((resultMessage) => typeof resultMessage.isError === "boolean")
      .map((resultMessage) => resultMessage.isError ? "error" : "done");

    if (explicitStatuses.length > 0) {
      return explicitStatuses.includes("error") ? "error" : "done";
    }

    if (toolExecution?.status === "error" || toolExecution?.status === "done") {
      return toolExecution.status;
    }

    return resultMessages.some((resultMessage) => isToolFailureText(resultMessage.text)) ? "error" : "done";
  }

  if (toolExecution?.status === "error") return "error";
  if (toolExecution?.status === "running") return "running";
  if (toolExecution?.status === "done") return "done";
  return "call";
}

function getToolActivityStatusLabel(status: ToolActivityState) {
  switch (status) {
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "error":
      return "Failed";
    default:
      return "Call";
  }
}

function renderToolActivityCard(options: {
  cardKey: string;
  title: string;
  preview: string | undefined;
  status: ToolActivityState;
  detail: ReturnType<typeof html>;
  variant: "inline" | "live" | "result";
  secondaryLabel: string | undefined;
}) {
  const isExpanded = options.status === "error" || state.expandedToolCards.has(options.cardKey);
  return html`
    <details
      class="pp-tool-card pp-tool-card-${options.variant} pp-tool-card-${options.status} pp-content-block"
      ?open=${isExpanded}
      @toggle=${(event: Event) => handleToolCardToggle(options.cardKey, event)}
    >
      <summary class="pp-tool-summary">
        <span class="pp-tool-summary-main">
          <span class="pp-tool-dot ${options.status}" aria-hidden="true"></span>
          <span class="pp-tool-summary-copy">
            <span class="pp-tool-name">${options.title}</span>
            ${options.preview ? html`<span class="pp-tool-preview">${options.preview}</span>` : nothing}
          </span>
        </span>
        <span class="pp-tool-meta">
          ${options.secondaryLabel ? html`<span class="pp-tool-chip">${options.secondaryLabel}</span>` : nothing}
          <span class="pp-tool-status ${options.status}">${getToolActivityStatusLabel(options.status)}</span>
          <span class="pp-tool-disclosure">${isExpanded ? "Hide" : "Details"}</span>
        </span>
      </summary>
      ${isExpanded ? html`<div class="pp-tool-content">${options.detail}</div>` : nothing}
    </details>
  `;
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
    const thinkingBlock = consumeThinkingBlock(lines, index);
    if (thinkingBlock) {
      flushMarkdown();
      if (thinkingBlock.message.text) {
        parts.push(thinkingBlock.message);
      }
      index = thinkingBlock.nextIndex;
      continue;
    }

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

function consumeThinkingBlock(lines: string[], startIndex: number) {
  if (lines[startIndex]?.trim() !== THINKING_START_MARKER) return undefined;

  let endIndex = startIndex + 1;
  while (endIndex < lines.length && lines[endIndex]?.trim() !== THINKING_END_MARKER) {
    endIndex += 1;
  }

  if (endIndex >= lines.length) return undefined;

  return {
    message: {
      type: "thinking" as const,
      text: lines.slice(startIndex + 1, endIndex).join("\n").trim(),
    },
    nextIndex: endIndex + 1,
  };
}

const toolCallHeaderPattern = /^\[tool call:\s*([^;\]]+?)(?:;\s*id=([^\]]+))?\]$/;

function parseToolCallHeader(line: string | undefined) {
  const match = line?.trim().match(toolCallHeaderPattern);
  if (!match) return undefined;

  const toolName = match[1]?.trim();
  if (!toolName) return undefined;

  const toolCallId = match[2]?.trim() || undefined;
  return { toolName, toolCallId };
}

function isToolCallHeaderLine(line: string | undefined) {
  return Boolean(parseToolCallHeader(line));
}

function consumeToolCall(lines: string[], startIndex: number) {
  const header = parseToolCallHeader(lines[startIndex]);
  if (!header) return undefined;

  let index = startIndex + 1;
  while (index < lines.length && lines[index]?.trim() === "") index += 1;

  if (index >= lines.length) {
    return {
      message: { toolName: header.toolName, toolCallId: header.toolCallId, arguments: "", preview: undefined },
      nextIndex: index,
    };
  }

  const jsonLines: string[] = [];
  for (let end = index; end < lines.length; end += 1) {
    if (isToolCallHeaderLine(lines[end])) break;

    jsonLines.push(lines[end] ?? "");
    const candidate = jsonLines.join("\n").trim();
    if (!candidate) continue;

    if (
      ((candidate.startsWith("{") && candidate.endsWith("}")) ||
        (candidate.startsWith("[") && candidate.endsWith("]")))
    ) {
      try {
        const parsedArguments = JSON.parse(candidate);
        return {
          message: {
            toolName: header.toolName,
            toolCallId: header.toolCallId,
            arguments: parsedArguments,
            preview: summarizeToolCallPreview(parsedArguments),
          },
          nextIndex: end + 1,
        };
      } catch {
        // Keep accumulating until the JSON block is complete.
      }
    }
  }

  let endIndex = index;
  while (endIndex < lines.length && !isToolCallHeaderLine(lines[endIndex])) {
    endIndex += 1;
  }

  const rawArguments = lines.slice(index, endIndex).join("\n").trim();
  return {
    message: {
      toolName: header.toolName,
      toolCallId: header.toolCallId,
      arguments: rawArguments,
      preview: summarizeToolCallPreview(rawArguments),
    },
    nextIndex: endIndex,
  };
}

function getAssistantMessageParts(message: ApiSessionSnapshot["messages"][number]) {
  if (Array.isArray(message.parts) && message.parts.length > 0) {
    const structuredParts = message.parts
      .flatMap((part): AssistantMessagePart[] => {
        if (part.type === "text") {
          return part.text.trim() ? [{ type: "markdown", text: part.text }] : [];
        }

        if (part.type === "thinking") {
          return part.text.trim() ? [{ type: "thinking", text: part.text }] : [];
        }

        if (part.type === "toolCall") {
          return [{
            type: "toolCall",
            toolCall: {
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              arguments: part.arguments,
              preview: summarizeToolCallPreview(part.arguments),
            },
          }];
        }

        return [];
      });

    if (structuredParts.length > 0) {
      return structuredParts;
    }
  }

  return parseAssistantMessageParts(message.text);
}

function renderToolCallMessage(
  toolCall: ParsedToolCallMessage,
  cardKey: string,
  resultMessages: ToolResultMessage[] = [],
  toolExecution: ApiSessionSnapshot["toolExecutions"][number] | undefined = undefined,
) {
  const status = getToolActivityState(toolExecution, resultMessages);
  const preview = getToolActivityPreview({
    toolCallPreview: toolCall.preview,
    resultMessages,
    toolExecution,
    status,
  });
  const secondaryLabel = resultMessages.length > 0
    ? resultMessages.length === 1
      ? "1 result"
      : `${resultMessages.length} results`
    : status === "running"
      ? "live"
      : undefined;
  const resultFallbackStatus = toolExecution?.status === "error" || toolExecution?.status === "done"
    ? toolExecution.status
    : undefined;

  return renderToolActivityCard({
    cardKey,
    title: toolCall.toolName,
    preview,
    status,
    variant: "inline",
    secondaryLabel,
    detail: html`
      <div class="pp-tool-section">
        <div class="pp-tool-section-label">Call</div>
        <div class="pp-tool-section-body">${renderToolCallArguments(toolCall.arguments)}</div>
      </div>
      ${resultMessages.length > 0
        ? resultMessages.map((resultMessage, index) =>
            renderToolResultSection(resultMessage, index, resultMessages.length, resultFallbackStatus)
          )
        : toolExecution?.text
          ? html`
              <div class="pp-tool-section pp-tool-section-result">
                <div class="pp-tool-section-label">${status === "error" ? "Error" : "Live output"}</div>
                <div class="pp-tool-section-body">${renderStructuredBlock(toolExecution.text)}</div>
              </div>
            `
          : status === "running"
            ? html`
                <div class="pp-tool-section pp-tool-section-result">
                  <div class="pp-tool-section-label">Status</div>
                  <div class="pp-tool-section-body"><span class="pp-tool-inline-note">Running…</span></div>
                </div>
              `
            : nothing}
    `,
  });
}

function renderToolResultSection(
  resultMessage: ToolResultMessage,
  index: number,
  total: number,
  fallbackStatus: Extract<ToolActivityState, "done" | "error"> | undefined = undefined,
) {
  const label = getToolResultState(resultMessage, fallbackStatus) === "error"
    ? total === 1
      ? "Error"
      : `Error ${index + 1}`
    : total === 1
      ? "Result"
      : `Result ${index + 1}`;
  return html`
    <div class="pp-tool-section pp-tool-section-result">
      <div class="pp-tool-section-label">${label}</div>
      <div class="pp-tool-section-body">${renderStructuredBlock(resultMessage.text)}</div>
    </div>
  `;
}

function renderMarkdown(text: string): ReturnType<typeof html> {
  const raw = markdownHtmlCache.get(text) ?? (() => {
    const rendered = marked.parse(text, { async: false }) as string;
    markdownHtmlCache.set(text, rendered);
    return rendered;
  })();
  return html`<div class="pp-content-block pp-markdown">${unsafeHTML(raw)}</div>`;
}

function renderThinking(text: string) {
  return html`
    <div class="pp-thinking">
      <div class="pp-thinking-label">Thinking</div>
      <div class="pp-thinking-content">${text}</div>
    </div>
  `;
}

function showCopyButtonState(button: HTMLButtonElement, label: string) {
  const previousLabel = button.textContent ?? "Copy";
  button.textContent = label;
  setTimeout(() => {
    button.textContent = previousLabel;
  }, 1500);
}

async function writeTextWithFallback(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    textarea.setSelectionRange(0, text.length);

    try {
      return document.execCommand("copy");
    } finally {
      textarea.remove();
    }
  }
}

function copyToClipboard(text: string, button: HTMLButtonElement) {
  void writeTextWithFallback(text).then((copied) => {
    showCopyButtonState(button, copied ? "Copied!" : "Failed");
  });
}

function copyMessageText(messageText: string, button: HTMLButtonElement) {
  if (!messageText.trim()) {
    showCopyButtonState(button, "Empty");
    return;
  }
  copyToClipboard(messageText, button);
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

async function handleMessageEdit(messageId: string) {
  try {
    const context = state.activeSession ? getMessageActionContexts(state.activeSession.messages).get(messageId) : undefined;
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

async function handleMessageForkFromHere(messageId: string) {
  try {
    const context = state.activeSession ? getMessageActionContexts(state.activeSession.messages).get(messageId) : undefined;
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

async function handleMessageRetry(messageId: string) {
  try {
    const context = state.activeSession ? getMessageActionContexts(state.activeSession.messages).get(messageId) : undefined;
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
  const target = event.target;
  if (!(target instanceof Element)) return;

  const copyButton = target.closest<HTMLButtonElement>(".pp-copy-btn[data-copy-id]");
  const copyId = copyButton?.dataset.copyId;
  if (!copyButton || !copyId) return;

  const text = codeBlockCopyCache.get(copyId);
  if (text === undefined) return;

  event.preventDefault();
  copyToClipboard(text, copyButton);
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
  requestRender();
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
    <div class="pp-message-actions" role="group" aria-label="Message actions">
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
        @click=${() => void handleMessageRetry(message.id)}
        aria-label="Retry from here"
      >Retry</button>
      <button
        class="pp-message-action-btn"
        type="button"
        ?disabled=${!canReplayPrompt}
        title=${replayTitle}
        @click=${() => void handleMessageEdit(message.id)}
        aria-label="Edit prompt from here"
      >Edit</button>
      <button
        class="pp-message-action-btn"
        type="button"
        ?disabled=${!canReplayPrompt}
        title=${replayTitle}
        @click=${() => void handleMessageForkFromHere(message.id)}
        aria-label="Fork from here"
      >Fork</button>
    </div>
  `;
}

function renderMessageRow(
  kind: "user" | "assistant" | "extension",
  content: ReturnType<typeof html>,
  actions?: ReturnType<typeof html>,
) {
  return html`
    <div class="pp-message-row pp-message-row-${kind}" data-message-kind=${kind}>
      <div class="pp-message-shell pp-message-shell-${kind}">
        <div class="pp-message-surface pp-message-surface-${kind}">${content}</div>
        ${actions ?? nothing}
      </div>
    </div>
  `;
}

function renderConversation(
  messages: ApiSessionSnapshot["messages"],
  toolExecutions: ApiSessionSnapshot["toolExecutions"] = [],
): ConversationRenderResult {
  const grouped: ReturnType<typeof html>[] = [];
  const consumedToolExecutionIds = new Set<string>();
  const messageActionContexts = getMessageActionContexts(messages);

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;

    if (message.role === "assistant") {
      const parts = getAssistantMessageParts(message);
      const toolCallParts = parts.filter((part): part is Extract<AssistantMessagePart, { type: "toolCall" }> =>
        part.type === "toolCall"
      );
      const groupedToolResults: ToolResultMessage[][] = [];
      const toolExecutionMatches: Array<ApiSessionSnapshot["toolExecutions"][number] | undefined> = [];

      if (toolCallParts.length > 0) {
        const trailingToolResults: ToolResultMessage[] = [];
        let nextIndex = index + 1;

        while (messages[nextIndex]?.role === "toolResult") {
          trailingToolResults.push(messages[nextIndex]!);
          nextIndex += 1;
        }

        for (let toolCallIndex = 0; toolCallIndex < toolCallParts.length; toolCallIndex += 1) {
          const toolCall = toolCallParts[toolCallIndex]!.toolCall;
          const assignedResults = toolCall.toolCallId
            ? trailingToolResults.filter((result) => result.toolCallId === toolCall.toolCallId)
            : [];

          if (assignedResults.length > 0) {
            for (const result of assignedResults) {
              const resultIndex = trailingToolResults.indexOf(result);
              if (resultIndex >= 0) {
                trailingToolResults.splice(resultIndex, 1);
              }
            }
          } else if (trailingToolResults.length > 0) {
            assignedResults.push(trailingToolResults.shift()!);
          }

          if (toolCallIndex === toolCallParts.length - 1 && trailingToolResults.length > 0) {
            assignedResults.push(...trailingToolResults.splice(0));
          }

          groupedToolResults.push(assignedResults);
        }

        if (groupedToolResults.some((results) => results.length > 0)) {
          index = nextIndex - 1;
        }
      }

      for (const part of parts) {
        if (part.type !== "toolCall") continue;
        const toolExecution = takeMatchingToolExecution(toolExecutions, part.toolCall, consumedToolExecutionIds);
        toolExecutionMatches.push(toolExecution);
        if (toolExecution) consumedToolExecutionIds.add(toolExecution.toolCallId);
      }

      grouped.push(renderMessage(message, messageActionContexts.get(message.id), groupedToolResults, toolExecutionMatches, parts));
      continue;
    }

    grouped.push(renderMessage(message, messageActionContexts.get(message.id)));
  }

  return {
    entries: grouped,
    remainingToolExecutions: toolExecutions.filter(
      (toolExecution) => !consumedToolExecutionIds.has(toolExecution.toolCallId),
    ),
  };
}

const template = () => {
  const renderedMessages = state.activeSession ? getRenderedMessages(state.activeSession) : [];
  const conversation = state.activeSession
    ? renderConversation(renderedMessages, state.activeSession.toolExecutions)
    : undefined;
  const detachedToolExecutions = conversation?.remainingToolExecutions.filter((tool) => tool.status !== "done") ?? [];
  const activeSessionListItem = getActiveSessionListItem();
  const sessionCwd = state.activeSession
    ? activeSessionListItem?.cwd ?? getSessionDirectoryOverride(state.activeSession)
    : undefined;
  const workspaceLabel = sessionCwd ? shortenCwd(sessionCwd) : undefined;
  const contextUsageLabel = formatContextUsage(state.activeSession?.contextUsage);
  const runningToolCount = state.activeSession?.toolExecutions.filter((tool) => tool.status === "running").length ?? 0;

  return html`
  <div class="pp-shell pp-shell-${state.displayMode}" data-display-mode=${state.displayMode}>
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
          class="pp-header-new-btn"
          @click=${openCreateProjectDialog}
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
        ? html`<button class="pp-sidebar-scrim" @click=${closeSidebar} aria-label="Close sidebar"></button>`
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
      <div class="pp-main">
        ${state.activeSession?.externallyDirty ? renderExternalBanner() : nothing}

        ${state.error ? html`<div class="pp-error" style="margin:0.75rem 1.5rem 0;">${state.error}</div>` : nothing}
        ${state.info ? html`<div class="pp-info" style="margin:0.75rem 1.5rem 0;">${state.info}</div>` : nothing}

        <div class="pp-messages">
          <div class="pp-messages-inner">
            ${state.isLoading
              ? renderSkeleton()
              : state.activeSession && renderedMessages.length
                ? conversation?.entries
                : html`<div class="pp-empty">No messages yet. Start typing below.</div>`}

            ${detachedToolExecutions.length
              ? detachedToolExecutions.map((tool) => renderToolCard(tool))
              : nothing}

            ${state.activeSession?.status === "streaming"
              ? html`<div style="margin-bottom:0.5rem;"><span class="pp-streaming-cursor"></span></div>`
              : nothing}
          </div>
        </div>

        ${renderExtensionWidgets("aboveEditor")}

        ${state.activeSession?.status === "streaming"
          ? html`
              <div class="pp-session-activity-shell">
                <div class="pp-session-activity">
                  <span class="pp-session-activity-dot" aria-hidden="true"></span>
                  <span class="pp-session-activity-text">
                    Agent working…
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
            ${state.extensionStatuses.map(
              (s) => html`<span style="font-size:0.6875rem;">${s.key}: ${s.text}</span>`,
            )}
            <button class="pp-statusbar-model" @click=${openModelsDialog}>
              ${state.activeSession?.model?.name ?? "No model"}
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
      </div>
    </div>

    <!-- Dialogs -->
    ${state.showCreateProjectDialog ? renderCreateProjectDialog() : nothing}
    ${state.showModels ? renderModelsDialog() : nothing}
    ${state.showThinkingLevels ? renderThinkingLevelsDialog() : nothing}
    ${state.showActions ? renderActionsDialog() : nothing}
    ${state.pendingExtensionUi ? renderExtensionUiDialog(state.pendingExtensionUi) : nothing}
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

/* ─── Message rendering ─── */

function renderMessage(
  message: ApiSessionSnapshot["messages"][number],
  messageActionContext: MessageActionContext | undefined,
  groupedToolResults: ToolResultMessage[][] = [],
  toolExecutionMatches: Array<ApiSessionSnapshot["toolExecutions"][number] | undefined> = [],
  assistantParts?: AssistantMessagePart[],
) {
  if (message.role === "user" || message.role === "user-with-attachments") {
    return renderMessageRow(
      "user",
      html`
        <div class="pp-msg-user">
          <div class="pp-msg-user-label">YOU</div>
          <div class="pp-msg-user-text">${message.text}</div>
        </div>
      `,
      renderMessageActions(message, messageActionContext, message.text),
    );
  }

  if (message.role === "assistant") {
    const parts = assistantParts ?? getAssistantMessageParts(message);
    let toolCallIndex = 0;
    return html`${parts.map((part, partIndex) => {
      if (part.type === "toolCall") {
        const currentToolCallIndex = toolCallIndex++;
        return renderToolCallMessage(
          part.toolCall,
          getToolCardKey("message", message.id, "tool-call", String(partIndex)),
          groupedToolResults[currentToolCallIndex] ?? [],
          toolExecutionMatches[currentToolCallIndex],
        );
      }

      if (part.type === "thinking") {
        return renderMessageRow(
          "assistant",
          html`
            <div class="pp-msg-assistant">
              ${renderThinking(part.text)}
            </div>
          `,
        );
      }

      return renderMessageRow(
        "assistant",
        html`
          <div class="pp-msg-assistant">
            ${renderMarkdown(part.text)}
          </div>
        `,
        renderMessageActions(message, messageActionContext, part.text),
      );
    })}`;
  }

  if (message.role === "toolResult") {
    const status = getToolResultState(message);
    return renderToolActivityCard({
      cardKey: getToolCardKey("message", message.id, "tool-result"),
      title: status === "error" ? "Tool error" : "Tool result",
      preview: summarizeToolExecutionPreview(message.text),
      status,
      variant: "result",
      secondaryLabel: "result",
      detail: html`
        <div class="pp-tool-section pp-tool-section-result">
          <div class="pp-tool-section-label">${status === "error" ? "Error" : "Result"}</div>
          <div class="pp-tool-section-body">${renderStructuredBlock(message.text)}</div>
        </div>
      `,
    });
  }

  // Extension / custom messages
  return renderMessageRow(
    "extension",
    html`
      <div class="pp-msg-assistant" style="opacity:0.85;">
        <div style="font-size:0.6875rem;font-weight:600;text-transform:uppercase;color:var(--pp-text-muted);margin-bottom:0.125rem;">
          ${message.role}
        </div>
        ${renderMarkdown(message.text)}
      </div>
    `,
  );
}

/* ─── Tool cards ─── */

function renderToolCard(tool: ApiSessionSnapshot["toolExecutions"][number]) {
  return renderToolActivityCard({
    cardKey: getToolCardKey("execution", tool.toolCallId),
    title: tool.toolName,
    preview: summarizeToolExecutionPreview(tool.text),
    status: tool.status,
    variant: "live",
    secondaryLabel: tool.status === "running" ? "live" : undefined,
    detail: html`
      <div class="pp-tool-section pp-tool-section-result">
        <div class="pp-tool-section-label">${tool.status === "error" ? "Error" : "Output"}</div>
        <div class="pp-tool-section-body">
          ${tool.text ? renderStructuredBlock(tool.text) : html`<span class="pp-tool-inline-note">Running…</span>`}
        </div>
      </div>
    `,
  });
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

/* ─── Project dialog ─── */

function renderCreateProjectDialog() {
  return html`
    <div class="pp-dialog-overlay" @click=${closeCreateProjectDialog}>
      <div class="pp-dialog" @click=${(event: Event) => event.stopPropagation()}>
        <div class="pp-dialog-title">Open project</div>
        <div class="pp-dialog-subtitle">
          Choose the directory for the new session. You can paste a path or use the native picker.
        </div>
        <div class="pp-dialog-section">
          <div class="pp-dialog-section-title">Project directory</div>
          <div class="pp-dialog-section-desc">The new session will use this directory as its working tree.</div>
          <div style="display:flex; gap:0.5rem; align-items:center;">
            <input
              class="pp-dialog-input"
              type="text"
              placeholder="/path/to/project"
              .value=${state.newProjectPath}
              @input=${updateNewProjectPath}
              @keydown=${handleCreateProjectPathKeyDown}
            />
            <button class="pp-dialog-btn" @click=${() => void pickProjectDirectory()} ?disabled=${state.isPickingProjectDirectory || state.isCreatingProjectSession}>
              ${state.isPickingProjectDirectory ? "Browsing…" : "Browse"}
            </button>
          </div>
          ${state.newProjectError
            ? html`<div class="pp-error" style="margin-top:0.75rem;">${state.newProjectError}</div>`
            : nothing}
        </div>
        <div style="display:flex; gap:0.5rem; justify-content:flex-end;">
          <button class="pp-dialog-btn" @click=${closeCreateProjectDialog} ?disabled=${state.isCreatingProjectSession || state.isPickingProjectDirectory}>
            Cancel
          </button>
          <button class="pp-dialog-btn primary" @click=${() => void createProjectSession()} ?disabled=${state.isCreatingProjectSession || state.isPickingProjectDirectory}>
            ${state.isCreatingProjectSession ? "Creating…" : "Create session"}
          </button>
        </div>
      </div>
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
          return html`
            <button class="pp-dialog-item" @click=${() => void setThinkingLevel(level)}>
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
                    @input=${handleExtensionUiValueInput}
                    placeholder=${request.placeholder ?? ""}
                  />`
                : html`<textarea
                    class="pp-dialog-input"
                    style="margin-bottom:0.5rem;min-height:10rem;font-family:monospace;"
                    .value=${state.extensionUiValue}
                    @input=${handleExtensionUiValueInput}
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

setupAppInteractions();
await bootstrap();
