import { html, render, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import type {
  ApiExtensionNotification,
  ApiExtensionStatusEntry,
  ApiExtensionUiRequest,
  ApiExtensionWidget,
  ApiForkMessage,
  ApiImageInput,
  ApiModelInfo,
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

type AppState = {
  sessions: ApiSessionListItem[];
  sessionsScope: "current" | "all";
  sessionsSearch: string;
  activeSession: ApiSessionSnapshot | undefined;
  availableModels: ApiModelInfo[];
  composerText: string;
  composerMode: ComposerMode;
  attachments: PendingAttachment[];
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
const sidebarMediaQuery = window.matchMedia(MOBILE_SIDEBAR_MEDIA_QUERY);

const state: AppState = {
  sessions: [],
  sessionsScope: "all",
  sessionsSearch: "",
  activeSession: undefined,
  availableModels: [],
  composerText: "",
  composerMode: "prompt",
  attachments: [],
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
let eventReconnectTimeout: ReturnType<typeof setTimeout> | undefined;
let eventReconnectAttempts = 0;
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
    if (state.sessions[0]?.live) {
      await attachToLiveSession(state.sessions[0].id);
    } else if (state.sessions[0]?.sessionFile) {
      await openSession(state.sessions[0].sessionFile);
    } else {
      await createSession();
    }
  } catch (error) {
    setError(getErrorMessage(error));
  } finally {
    state.isLoading = false;
    renderApp();
  }
}

async function loadSessions(scope = state.sessionsScope) {
  state.sessionsScope = scope;
  const response = await apiGet<{ sessions: ApiSessionListItem[] }>(`/api/sessions?scope=${scope}`);
  state.sessions = response.sessions;
  renderApp();
}

async function loadModels() {
  const response = await apiGet<{ models: ApiModelInfo[] }>("/api/models");
  state.availableModels = response.models;
}

function refreshSessionsInBackground(scope = state.sessionsScope) {
  void loadSessions(scope).catch((error) => {
    state.error = getErrorMessage(error);
    renderApp();
  });
}

async function createSession() {
  const response = await apiPost<{ snapshot: ApiSessionSnapshot }>("/api/sessions", {});
  openSnapshot(response.snapshot);
  refreshSessionsInBackground();
}

async function handleCreateSession() {
  await createSession();
  closeSidebarIfMobile();
}

async function openSession(sessionFile: string) {
  const response = await apiPost<{ snapshot: ApiSessionSnapshot }>("/api/sessions/open", { path: sessionFile });
  openSnapshot(response.snapshot);
  refreshSessionsInBackground();
}

async function attachToLiveSession(sessionId: string) {
  const response = await apiGet<{ snapshot: ApiSessionSnapshot }>(`/api/sessions/${sessionId}`);
  openSnapshot(response.snapshot);
}

async function sendComposer() {
  if (!state.activeSession) return;
  if (!state.composerText.trim() && state.attachments.length === 0) return;

  const submittedText = state.composerText;
  const submittedAttachments = [...state.attachments];

  // Clear immediately to avoid race with SSE events
  state.composerText = "";
  state.attachments = [];
  state.info = undefined;
  renderApp();

  const body = {
    message: submittedText,
    images: submittedAttachments.map<ApiImageInput>((a) => ({
      fileName: a.fileName,
      mimeType: a.mimeType,
      data: a.data,
    })),
  };

  const sessionId = state.activeSession.sessionId;

  try {
    if (state.composerMode === "prompt") {
      await apiPost(`/api/sessions/${sessionId}/prompt`, body);
    } else if (state.composerMode === "steer") {
      await apiPost(`/api/sessions/${sessionId}/steer`, { message: submittedText });
    } else {
      await apiPost(`/api/sessions/${sessionId}/follow-up`, { message: submittedText });
    }
  } catch (error) {
    state.composerText = submittedText;
    state.attachments = submittedAttachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      preview: a.preview,
      data: a.data,
    }));
    state.error = getErrorMessage(error);
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
}

async function setModel(provider: string, modelId: string) {
  if (!state.activeSession) return;
  await apiPost(`/api/sessions/${state.activeSession.sessionId}/model`, { provider, modelId });
  state.showModels = false;
}

async function setThinkingLevel(level: ThinkingLevel) {
  if (!state.activeSession) return;
  await apiPost(`/api/sessions/${state.activeSession.sessionId}/thinking-level`, { thinkingLevel: level });
}

async function openActions() {
  if (!state.activeSession) return;
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
      apiGet<{ messages: ApiForkMessage[] }>(`/api/sessions/${state.activeSession.sessionId}/fork-messages`),
      apiGet<{ messages: ApiTreeMessage[] }>(`/api/sessions/${state.activeSession.sessionId}/tree-messages`),
    ]);
    state.forkMessages = forkResponse.messages;
    state.treeMessages = treeResponse.messages;
  } catch (error) {
    state.error = getErrorMessage(error);
  } finally {
    state.isLoadingForkMessages = false;
    state.isLoadingTreeMessages = false;
    renderApp();
  }
}

async function renameSession() {
  if (!state.activeSession) return;
  const name = state.renameText.trim();
  if (!name) return;
  const response = await apiPost<{ snapshot: ApiSessionSnapshot }>(
    `/api/sessions/${state.activeSession.sessionId}/rename`,
    { name },
  );
  openSnapshot(response.snapshot);
  refreshSessionsInBackground();
  state.info = "Session renamed.";
  renderApp();
}

async function reopenActiveSession() {
  if (!state.activeSession || state.isReopeningSession) return;
  state.isReopeningSession = true;
  renderApp();
  try {
    const response = await apiPost<{ snapshot: ApiSessionSnapshot }>(
      `/api/sessions/${state.activeSession.sessionId}/reopen`,
      {},
    );
    openSnapshot(response.snapshot);
    refreshSessionsInBackground();
    state.info = "Session reloaded from disk.";
  } catch (error) {
    state.error = getErrorMessage(error);
  } finally {
    state.isReopeningSession = false;
    renderApp();
  }
}

async function forkFromEntry(entryId: string) {
  if (!state.activeSession) return;
  const response = await apiPost<{ cancelled: boolean; selectedText: string; snapshot: ApiSessionSnapshot }>(
    `/api/sessions/${state.activeSession.sessionId}/fork`,
    { entryId },
  );
  if (response.cancelled) return;
  state.composerText = response.selectedText;
  state.showActions = false;
  openSnapshot(response.snapshot);
  refreshSessionsInBackground();
  state.info = "Fork created. The selected prompt was copied into the composer.";
  renderApp();
}

async function navigateTree(entryId: string) {
  if (!state.activeSession) return;
  const response = await apiPost<{ cancelled: boolean; editorText?: string; snapshot: ApiSessionSnapshot }>(
    `/api/sessions/${state.activeSession.sessionId}/tree`,
    { entryId },
  );
  if (response.cancelled) return;
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

function openSnapshot(snapshot: ApiSessionSnapshot) {
  const previousSessionId = state.activeSession?.sessionId;
  state.activeSession = snapshot;
  if (previousSessionId !== snapshot.sessionId) {
    state.expandedToolCards = new Set<string>();
  }
  state.renameText = snapshot.title;
  state.pendingExtensionUi = undefined;
  state.extensionUiValue = "";
  state.extensionStatuses = [];
  state.extensionWidgets = [];
  state.pageTitle = snapshot.title;
  document.title = state.pageTitle;
  state.error = undefined;
  state.isLoading = false;
  state.switchingSessionId = undefined;
  state.liveConnectionState = "connecting";
  connectEvents(snapshot.sessionId);
  renderApp();
  scrollToBottom();
}

function connectEvents(sessionId: string) {
  clearEventReconnectTimer();
  currentEvents?.close();
  const events = new EventSource(`/api/sessions/${sessionId}/events`);
  currentEvents = events;

  events.onopen = () => {
    if (currentEvents !== events) return;
    eventReconnectAttempts = 0;
    state.liveConnectionState = "connected";
    renderApp();
  };

  events.onmessage = (messageEvent) => {
    if (currentEvents !== events) return;
    const event = JSON.parse(messageEvent.data) as SessionEvent;
    if (event.type === "snapshot") {
      state.activeSession = event.snapshot;
      state.renameText = event.snapshot.title;
      state.pageTitle = event.snapshot.title;
      document.title = event.snapshot.title;
      void loadSessions();
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
    if (currentEvents !== events) return;
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
  if (!activeSession) return;

  try {
    await attachToLiveSession(sessionId);
    return;
  } catch {
    if (!activeSession.sessionFile) {
      scheduleReconnect(sessionId);
      return;
    }
  }

  try {
    await openSession(activeSession.sessionFile!);
  } catch {
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
      await attachToLiveSession(session.id);
      return;
    }
    if (session.sessionFile) {
      await openSession(session.sessionFile);
      return;
    }
  } catch (error) {
    state.error = getErrorMessage(error);
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
            : state.activeSession?.messages.length
              ? renderConversation(state.activeSession.messages)
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
            @input=${(e: Event) => { state.composerText = (e.target as HTMLTextAreaElement).value; }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendComposer(); }
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
              >\u27a4</button>`}
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
          <button class="pp-statusbar-model" @click=${() => { state.showModels = true; renderApp(); }}>
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
                ${state.activeSession.messages.length} msgs
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

/* ─── Models dialog ─── */

function renderModelsDialog() {
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
        ${state.availableModels.map(
          (m) => html`
            <button class="pp-dialog-item" @click=${() => setModel(m.provider, m.id)}>
              <div class="pp-dialog-item-title">${m.name}</div>
              <div class="pp-dialog-item-desc">${m.provider}/${m.id}</div>
            </button>
          `,
        )}
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

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin" });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

if (typeof sidebarMediaQuery.addEventListener === "function") {
  sidebarMediaQuery.addEventListener("change", handleSidebarViewportChange);
} else {
  sidebarMediaQuery.addListener(handleSidebarViewportChange);
}

await bootstrap();
