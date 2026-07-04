import { html, nothing } from "lit";
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
import type { ApiSessionSnapshot } from "@pi-web-app/shared";

export type UserPromptMessage = ApiSessionSnapshot["messages"][number] & {
  role: "user" | "user-with-attachments";
};

export type MessageActionContext = {
  promptMessage: ApiSessionSnapshot["messages"][number];
  promptOrdinal: number;
  selectedMessage: ApiSessionSnapshot["messages"][number];
  usesNearestPrompt: boolean;
};

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

type BoundedTextCache = {
  values: Map<string, string>;
  maxEntries: number;
  maxChars: number;
  charCount: number;
};

export type ConversationRenderResult = {
  entries: ReturnType<typeof html>[];
  remainingToolExecutions: ApiSessionSnapshot["toolExecutions"];
};

export type ConversationRenderingOptions = {
  sessionId: string | undefined;
  actionContextMessages: ApiSessionSnapshot["messages"];
  expandedToolCards: ReadonlySet<string>;
  onToolCardToggle: (cardKey: string, event: Event) => void;
  renderMessageActions: (
    message: ApiSessionSnapshot["messages"][number],
    messageActionContext: MessageActionContext | undefined,
    copyText?: string,
  ) => ReturnType<typeof html>;
};

const ASSISTANT_MESSAGE_PARTS_CACHE_LIMIT = 400;
const MARKDOWN_HTML_CACHE_LIMIT = 200;
const MARKDOWN_HTML_CACHE_CHAR_LIMIT = 2_000_000;
const CODE_BLOCK_COPY_CACHE_LIMIT = 200;
const CODE_BLOCK_COPY_CACHE_CHAR_LIMIT = 1_000_000;
const THINKING_START_MARKER = "<<<pi-thinking>>>";
const THINKING_END_MARKER = "<<<pi-thinking-end>>>";

const assistantMessagePartsCache = new Map<string, AssistantMessagePart[]>();
const markdownHtmlCache = createBoundedTextCache(MARKDOWN_HTML_CACHE_LIMIT, MARKDOWN_HTML_CACHE_CHAR_LIMIT);
const codeBlockCopyCache = createBoundedTextCache(CODE_BLOCK_COPY_CACHE_LIMIT, CODE_BLOCK_COPY_CACHE_CHAR_LIMIT);
const emptyMessageActionContexts = new Map<string, MessageActionContext>();
let cachedMessageActionContextSource: ApiSessionSnapshot["messages"] | undefined;
let cachedMessageActionContexts = emptyMessageActionContexts;

function createBoundedTextCache(maxEntries: number, maxChars: number): BoundedTextCache {
  return {
    values: new Map<string, string>(),
    maxEntries,
    maxChars,
    charCount: 0,
  };
}

function clearBoundedTextCache(cache: BoundedTextCache) {
  cache.values.clear();
  cache.charCount = 0;
}

function getLruCacheValue<K, V>(cache: Map<K, V>, key: K) {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setLruCacheValue<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number) {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);

  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
  }
}

function getBoundedTextCacheValue(cache: BoundedTextCache, key: string) {
  const value = cache.values.get(key);
  if (value === undefined) return undefined;
  cache.values.delete(key);
  cache.values.set(key, value);
  return value;
}

function setBoundedTextCacheValue(cache: BoundedTextCache, key: string, value: string) {
  const existing = cache.values.get(key);
  if (existing !== undefined) {
    cache.values.delete(key);
    cache.charCount -= existing.length;
  }

  cache.values.set(key, value);
  cache.charCount += value.length;

  while (cache.values.size > cache.maxEntries || cache.charCount > cache.maxChars) {
    const oldestEntry = cache.values.entries().next().value;
    if (!oldestEntry) {
      break;
    }

    const [oldestKey, oldestValue] = oldestEntry;
    cache.values.delete(oldestKey);
    cache.charCount -= oldestValue.length;
  }
}

function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

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

function clearMessageActionContextCache() {
  cachedMessageActionContextSource = undefined;
  cachedMessageActionContexts = emptyMessageActionContexts;
}

export function isUserPromptMessage(
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

export function clearRenderedMessageCaches() {
  assistantMessagePartsCache.clear();
  clearBoundedTextCache(markdownHtmlCache);
  clearBoundedTextCache(codeBlockCopyCache);
  clearMessageActionContextCache();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncateText(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function getToolCardKey(rendering: ConversationRenderingOptions, ...parts: string[]) {
  return [rendering.sessionId ?? "no-session", ...parts].join(":");
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
  const baseId = `code-block-${hashText(text)}`;
  let copyId = baseId;
  let collisionIndex = 1;

  while (true) {
    const cachedText = getBoundedTextCacheValue(codeBlockCopyCache, copyId);
    if (cachedText === undefined || cachedText === text) {
      setBoundedTextCacheValue(codeBlockCopyCache, copyId, text);
      return copyId;
    }

    copyId = `${baseId}-${collisionIndex}`;
    collisionIndex += 1;
  }
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
        return truncateText(value, 60);
      }
    }
  }

  return truncateText(trimmed.replace(/\s+/g, " "), 60);
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
  return firstMeaningfulLine ? truncateText(firstMeaningfulLine, 80) : undefined;
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

function renderToolActivityCard(rendering: ConversationRenderingOptions, options: {
  cardKey: string;
  title: string;
  preview: string | undefined;
  status: ToolActivityState;
  detail: ReturnType<typeof html>;
  variant: "inline" | "live" | "result";
  secondaryLabel: string | undefined;
}) {
  const isExpanded = rendering.expandedToolCards.has(options.cardKey);
  return html`
    <details
      class="pp-tool-card pp-tool-card-${options.variant} pp-tool-card-${options.status} pp-content-block"
      ?open=${isExpanded}
      @toggle=${(event: Event) => rendering.onToolCardToggle(options.cardKey, event)}
    >
      <summary class="pp-tool-summary">
        <span class="pp-tool-summary-main">
          <span class="pp-tool-connector ${options.status}" aria-hidden="true">\u2514</span>
          <span class="pp-tool-summary-copy">
            <span class="pp-tool-name">${options.title}</span>
            ${options.preview ? html`<span class="pp-tool-preview">${options.preview}</span>` : nothing}
          </span>
        </span>
        <span class="pp-tool-meta">
          ${options.status !== "call"
            ? html`<span class="pp-tool-status ${options.status}">${getToolActivityStatusLabel(options.status)}</span>`
            : nothing}
          <span class="pp-tool-disclosure">${isExpanded ? "Hide" : "Details"}</span>
        </span>
      </summary>
      ${isExpanded ? html`<div class="pp-tool-content">${options.detail}</div>` : nothing}
    </details>
  `;
}

function parseAssistantMessageParts(text: string): AssistantMessagePart[] {
  const cached = getLruCacheValue(assistantMessagePartsCache, text);
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
  // Only fall back to the raw text when nothing was structurally recognized.
  const resolvedParts: AssistantMessagePart[] = parts.length ? parts : [{ type: "markdown", text }];
  setLruCacheValue(assistantMessagePartsCache, text, resolvedParts, ASSISTANT_MESSAGE_PARTS_CACHE_LIMIT);
  return resolvedParts;
}

function consumeThinkingBlock(lines: string[], startIndex: number) {
  if (lines[startIndex]?.trim() !== THINKING_START_MARKER) return undefined;

  let endIndex = startIndex + 1;
  while (endIndex < lines.length && lines[endIndex]?.trim() !== THINKING_END_MARKER) {
    endIndex += 1;
  }

  // While streaming, the closing marker may not have arrived yet. Treat the
  // remaining lines as an in-progress thinking block so the raw marker and
  // partial thinking text are never shown as plain text.
  const terminated = endIndex < lines.length;
  return {
    message: {
      type: "thinking" as const,
      text: lines.slice(startIndex + 1, endIndex).join("\n").trim(),
    },
    nextIndex: terminated ? endIndex + 1 : lines.length,
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

const TOOL_CALL_VERBS: Record<string, string> = {
  bash: "Ran",
  read: "Read",
  write: "Wrote",
  edit: "Edited",
  find: "Find",
  grep: "Grep",
  ls: "List",
};

function compactArgValue(value: unknown): string {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

// Builds a compact, TUI-style line for a tool call: a friendly verb plus a
// truncated summary of its key argument. Unknown tools fall back to the tool
// name and a truncated key=value list.
function formatToolCallSummary(toolName: string, argsValue: unknown): { verb: string; summary: string } {
  const parsed = typeof argsValue === "string" ? tryParseJson(argsValue) : argsValue;
  const record = isRecord(parsed) && !Array.isArray(parsed) ? parsed : undefined;
  const get = (key: string) => (record ? compactArgValue(record[key]) : "");

  switch (toolName) {
    case "bash":
      return { verb: "Ran", summary: truncateText(get("command"), 100) };
    case "read": {
      const path = get("path") || get("file_path");
      const offset = record?.offset;
      const limit = record?.limit;
      let range = "";
      if (typeof offset === "number") {
        range = typeof limit === "number" ? `:${offset}-${offset + limit - 1}` : `:${offset}`;
      }
      return { verb: "Read", summary: truncateText(path, 100) + range };
    }
    case "write":
      return { verb: "Wrote", summary: truncateText(get("path") || get("file_path"), 100) };
    case "edit":
      return { verb: "Edited", summary: truncateText(get("path") || get("file_path"), 100) };
    case "find": {
      const inPath = get("path");
      return { verb: "Find", summary: truncateText(get("pattern") + (inPath ? ` in ${inPath}` : ""), 100) };
    }
    case "grep":
      return { verb: "Grep", summary: truncateText(get("pattern"), 100) };
    case "ls":
      return { verb: "List", summary: truncateText(get("path") || ".", 100) };
    default: {
      if (record) {
        const params = Object.entries(record)
          .map(([key, value]) => `${key}=${compactArgValue(value)}`)
          .join(", ");
        return { verb: TOOL_CALL_VERBS[toolName] ?? toolName, summary: truncateText(params, 100) };
      }
      return { verb: TOOL_CALL_VERBS[toolName] ?? toolName, summary: truncateText(compactArgValue(parsed), 100) };
    }
  }
}

function renderToolCallMessage(
  rendering: ConversationRenderingOptions,
  toolCall: ParsedToolCallMessage,
  cardKey: string,
  resultMessages: ToolResultMessage[] = [],
  toolExecution: ApiSessionSnapshot["toolExecutions"][number] | undefined = undefined,
) {
  const status = getToolActivityState(toolExecution, resultMessages);
  const { summary } = formatToolCallSummary(toolCall.toolName, toolCall.arguments);
  const resultPreview = resultMessages
    .map((resultMessage) => summarizeToolExecutionPreview(resultMessage.text))
    .find((preview): preview is string => Boolean(preview))
    ?? (toolExecution?.text ? summarizeToolExecutionPreview(toolExecution.text) : undefined);

  return renderToolActivityCard(rendering, {
    cardKey,
    title: toolCall.toolName,
    preview: resultPreview ?? summary,
    status,
    variant: "inline",
    secondaryLabel: undefined,
    detail: buildToolCallDetail(toolCall, resultMessages, toolExecution, status),
  });
}

function buildToolCallDetail(
  toolCall: ParsedToolCallMessage,
  resultMessages: ToolResultMessage[],
  toolExecution: ApiSessionSnapshot["toolExecutions"][number] | undefined,
  status: ToolActivityState,
) {
  const resultFallbackStatus = toolExecution?.status === "error" || toolExecution?.status === "done"
    ? toolExecution.status
    : undefined;

  return html`
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
  `;
}

type ToolCallGroupEntry = {
  toolCall: ParsedToolCallMessage;
  resultMessages: ToolResultMessage[];
  toolExecution: ApiSessionSnapshot["toolExecutions"][number] | undefined;
  cardKey: string;
  summary: string;
  status: ToolActivityState;
};

function aggregateToolGroupStatus(entries: ToolCallGroupEntry[]): ToolActivityState {
  if (entries.some((entry) => entry.status === "error")) return "error";
  if (entries.some((entry) => entry.status === "running")) return "running";
  if (entries.every((entry) => entry.status === "done")) return "done";
  return "call";
}

// Renders a run of consecutive same-verb tool calls under a single verb header,
// listing each invocation as an expandable bullet (e.g. one "Read" + N files).
function renderToolCallGroup(rendering: ConversationRenderingOptions, verb: string, entries: ToolCallGroupEntry[]) {
  const status = aggregateToolGroupStatus(entries);
  return html`
    <div class="pp-tool-group pp-tool-group-${status} pp-content-block">
      <div class="pp-tool-group-head">
        <span class="pp-tool-connector ${status}" aria-hidden="true">\u2514</span>
        <span class="pp-tool-name">${verb}</span>
        <span class="pp-tool-group-count">${entries.length}</span>
      </div>
      <ul class="pp-tool-group-list">
        ${entries.map((entry) => {
          const isExpanded = rendering.expandedToolCards.has(entry.cardKey);
          return html`
            <li class="pp-tool-group-item pp-tool-group-item-${entry.status}">
              <details
                ?open=${isExpanded}
                @toggle=${(event: Event) => rendering.onToolCardToggle(entry.cardKey, event)}
              >
                <summary class="pp-tool-group-item-summary">
                  <span class="pp-tool-group-bullet" aria-hidden="true">-</span>
                  <span class="pp-tool-group-item-text">${entry.summary || entry.toolCall.toolName}</span>
                  ${entry.status === "error"
                    ? html`<span class="pp-tool-status error">${getToolActivityStatusLabel("error")}</span>`
                    : nothing}
                  <span class="pp-tool-disclosure">${isExpanded ? "Hide" : "Details"}</span>
                </summary>
                <div class="pp-tool-content">
                  ${buildToolCallDetail(entry.toolCall, entry.resultMessages, entry.toolExecution, entry.status)}
                </div>
              </details>
            </li>
          `;
        })}
      </ul>
    </div>
  `;
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
  const raw = getBoundedTextCacheValue(markdownHtmlCache, text) ?? (() => {
    const rendered = marked.parse(text, { async: false }) as string;
    setBoundedTextCacheValue(markdownHtmlCache, text, rendered);
    return rendered;
  })();
  return html`<div class="pp-content-block pp-markdown">${unsafeHTML(raw)}</div>`;
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

export function copyMessageText(messageText: string, button: HTMLButtonElement) {
  if (!messageText.trim()) {
    showCopyButtonState(button, "Empty");
    return;
  }
  copyToClipboard(messageText, button);
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
      return `${renderMarkdownCodeBlock(text, lang)}
`;
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

export function handleCodeCopyClick(event: Event) {
  const target = event.target;
  if (!(target instanceof Element)) return false;

  const copyButton = target.closest<HTMLButtonElement>(".pp-copy-btn[data-copy-id]");
  const copyId = copyButton?.dataset.copyId;
  if (!copyButton || !copyId) return false;

  const text = getBoundedTextCacheValue(codeBlockCopyCache, copyId);
  if (text === undefined) return false;

  event.preventDefault();
  copyToClipboard(text, copyButton);
  return true;
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

export function renderConversation(
  messages: ApiSessionSnapshot["messages"],
  toolExecutions: ApiSessionSnapshot["toolExecutions"] = [],
  rendering: ConversationRenderingOptions,
): ConversationRenderResult {
  const grouped: ReturnType<typeof html>[] = [];
  const consumedToolExecutionIds = new Set<string>();
  const messageActionContexts = getMessageActionContexts(rendering.actionContextMessages);

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

      grouped.push(renderMessage(rendering, message, messageActionContexts.get(message.id), groupedToolResults, toolExecutionMatches, parts));
      continue;
    }

    grouped.push(renderMessage(rendering, message, messageActionContexts.get(message.id)));
  }

  return {
    entries: grouped,
    remainingToolExecutions: toolExecutions.filter(
      (toolExecution) => !consumedToolExecutionIds.has(toolExecution.toolCallId),
    ),
  };
}

/* ─── Message rendering ─── */

function renderMessage(
  rendering: ConversationRenderingOptions,
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
      rendering.renderMessageActions(message, messageActionContext, message.text),
    );
  }

  if (message.role === "assistant") {
    const parts = assistantParts ?? getAssistantMessageParts(message);
    const blocks: ReturnType<typeof html>[] = [];
    let toolCallIndex = 0;
    let runVerb: string | undefined;
    let run: ToolCallGroupEntry[] = [];

    const flushRun = () => {
      if (run.length === 0) return;
      const entries = run;
      const verb = runVerb ?? "";
      blocks.push(
        entries.length === 1
          ? renderToolCallMessage(
              rendering,
              entries[0]!.toolCall,
              entries[0]!.cardKey,
              entries[0]!.resultMessages,
              entries[0]!.toolExecution,
            )
          : renderToolCallGroup(rendering, verb, entries),
      );
      run = [];
      runVerb = undefined;
    };

    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex]!;
      if (part.type === "toolCall") {
        const currentToolCallIndex = toolCallIndex++;
        const resultMessages = groupedToolResults[currentToolCallIndex] ?? [];
        const toolExecution = toolExecutionMatches[currentToolCallIndex];
        const status = getToolActivityState(toolExecution, resultMessages);
        const { verb, summary } = formatToolCallSummary(part.toolCall.toolName, part.toolCall.arguments);
        if (runVerb !== undefined && runVerb !== verb) flushRun();
        runVerb = verb;
        run.push({
          toolCall: part.toolCall,
          resultMessages,
          toolExecution,
          cardKey: getToolCardKey(rendering, "message", message.id, "tool-call", String(partIndex)),
          summary,
          status,
        });
        continue;
      }

      if (part.type === "thinking") {
        flushRun();
        blocks.push(
          renderMessageRow(
            "assistant",
            html`
              <details class="pp-thinking">
                <summary class="pp-thinking-summary">
                  <span class="pp-thinking-label">Thinking</span>
                  <span class="pp-thinking-disclosure" aria-hidden="true"></span>
                </summary>
                <pre class="pp-thinking-content">${part.text}</pre>
              </details>
            `,
          ),
        );
        continue;
      }

      flushRun();
      blocks.push(
        renderMessageRow(
          "assistant",
          html`
            <div class="pp-msg-assistant">
              ${renderMarkdown(part.text)}
            </div>
          `,
          rendering.renderMessageActions(message, messageActionContext, part.text),
        ),
      );
    }

    flushRun();
    return html`${blocks}`;
  }

  if (message.role === "toolResult") {
    const status = getToolResultState(message);
    return renderToolActivityCard(rendering, {
      cardKey: getToolCardKey(rendering, "message", message.id, "tool-result"),
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

export function renderToolCard(rendering: ConversationRenderingOptions, tool: ApiSessionSnapshot["toolExecutions"][number]) {
  return renderToolActivityCard(rendering, {
    cardKey: getToolCardKey(rendering, "execution", tool.toolCallId),
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
