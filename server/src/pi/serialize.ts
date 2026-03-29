import type { ApiMessage, ApiModelInfo, ApiSessionSnapshot, ApiToolExecution, SessionStatus } from "@pi-web-app/shared";

const MAX_JSON_PREVIEW = 1_200;
const THINKING_START_MARKER = "<<<pi-thinking>>>";
const THINKING_END_MARKER = "<<<pi-thinking-end>>>";

export const serializeModel = (model: any): ApiModelInfo | undefined => {
  if (!model?.provider || !model?.id) return undefined;

  return {
    provider: String(model.provider),
    id: String(model.id),
    name: String(model.name ?? model.id),
  };
};

export const serializeMessage = (message: any, index: number): ApiMessage | undefined => {
  const serializedMessage: ApiMessage = {
    id: String(message?.id ?? `${message?.role ?? "message"}-${index}`),
    role: String(message?.role ?? "unknown"),
    text: extractMessageText(message),
    timestamp: message?.timestamp ? String(message.timestamp) : undefined,
    ...(typeof message?.isError === "boolean" ? { isError: message.isError } : {}),
  };

  return serializedMessage.text.trim().length > 0 ? serializedMessage : undefined;
};

export const serializeMessages = (messages: any[] | undefined): ApiMessage[] => {
  if (!messages) return [];

  return messages
    .map((message, index) => serializeMessage(message, index))
    .filter((message): message is ApiMessage => Boolean(message));
};

export const deriveTitle = (options: {
  messages: ApiMessage[];
  sessionFile: string | undefined;
  sessionName: string | undefined;
}): string => {
  if (options.sessionName?.trim()) {
    return options.sessionName.trim();
  }

  const firstUserMessage = options.messages.find((message) =>
    message.role === "user" || message.role === "user-with-attachments",
  );

  if (firstUserMessage?.text.trim()) {
    const title = summarizeUserMessageForTitle(firstUserMessage.text);
    if (title) return title;
  }

  if (options.sessionFile) {
    const fileName = options.sessionFile.split("/").at(-1);
    if (fileName) return fileName;
  }

  return "New session";
};

export const extractStatus = (session: any): SessionStatus => {
  if (session.isStreaming) return "streaming";
  return "idle";
};

export const createSnapshotMetadata = (options: {
  session: any;
  sessionName: string | undefined;
  sessionFile: string | undefined;
  messages: ApiMessage[];
  externallyDirty: boolean;
  contextUsage: ApiSessionSnapshot["contextUsage"];
}): Pick<ApiSessionSnapshot, "title" | "status" | "live" | "externallyDirty" | "model" | "thinkingLevel" | "contextUsage"> => ({
  title: deriveTitle({
    messages: options.messages,
    sessionFile: options.sessionFile,
    sessionName: options.sessionName,
  }),
  status: extractStatus(options.session),
  live: true,
  externallyDirty: options.externallyDirty,
  model: serializeModel(options.session.model ?? options.session.state?.model),
  thinkingLevel: String(options.session.thinkingLevel ?? options.session.state?.thinkingLevel ?? "off"),
  contextUsage: options.contextUsage,
});

export const createSnapshot = (options: {
  session: any;
  sessionName: string | undefined;
  toolExecutions: Map<string, ApiToolExecution>;
  externallyDirty: boolean;
  contextUsage: ApiSessionSnapshot["contextUsage"];
}): ApiSessionSnapshot => {
  const messages = serializeMessages(options.session.state?.messages);
  const sessionFile = options.session.sessionFile ? String(options.session.sessionFile) : undefined;

  return {
    sessionId: String(options.session.sessionId),
    sessionFile,
    ...createSnapshotMetadata({
      session: options.session,
      sessionName: options.sessionName,
      sessionFile,
      messages,
      externallyDirty: options.externallyDirty,
      contextUsage: options.contextUsage,
    }),
    messages,
    toolExecutions: [...options.toolExecutions.values()].sort((left, right) =>
      left.startedAt.localeCompare(right.startedAt),
    ),
  };
};

export const extractMessageText = (message: any): string => {
  if (typeof message?.content === "string") return message.content;

  if (Array.isArray(message?.content)) {
    const text = message.content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part?.type === "thinking") return formatThinkingPart(part);
        const partText = extractTextPart(part);
        if (partText) return partText;
        if (part?.type === "image") return `[image: ${part?.source?.mediaType ?? "unknown"}]`;
        if (part?.type === "toolCall") {
          return formatToolCall(part);
        }
        return safeJson(part);
      })
      .filter(Boolean)
      .join("\n");

    if (text) return text;
  }

  const errorText = extractMessageError(message);
  if (errorText) return errorText;

  if (typeof message?.result === "string") return message.result;
  if (typeof message?.message === "string") return message.message;

  return "";
};

const extractTextPart = (part: any): string | undefined => {
  if (typeof part?.text === "string") return part.text;
  if (typeof part?.content === "string") return part.content;
  if (typeof part?.thinking === "string") return part.thinking;
  return undefined;
};

const formatThinkingPart = (part: any): string => {
  const text = extractTextPart(part)?.trim();
  if (!text) return "";
  return [THINKING_START_MARKER, text, THINKING_END_MARKER].join("\n");
};

const imageMarkerPattern = /^\[image:\s*[^\]]+\]$/i;
const clipboardImagePathPattern = /(?:^|\/)pi-clipboard-[\w-]+\.(png|jpe?g|gif|webp)$/i;

const summarize = (text: string): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "New session";
  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69)}...`;
};

const summarizeUserMessageForTitle = (text: string): string | undefined => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return undefined;

  const textLines = lines.filter((line) => !imageMarkerPattern.test(line) && !clipboardImagePathPattern.test(line));
  if (textLines.length > 0) {
    return summarize(textLines.join(" "));
  }

  if (lines.some((line) => imageMarkerPattern.test(line) || clipboardImagePathPattern.test(line))) {
    return "Pasted image";
  }

  return undefined;
};

const formatToolCall = (toolCall: any): string => {
  const toolName = typeof toolCall?.name === "string" ? toolCall.name : "unknown";
  const toolCallId = typeof toolCall?.id === "string" && toolCall.id.trim()
    ? toolCall.id.trim()
    : undefined;
  const args = toolCall?.arguments ?? toolCall?.partialJson;
  const formattedArgs = typeof args === "string" ? args : safeJson(args);
  const header = toolCallId
    ? `[tool call: ${toolName}; id=${toolCallId}]`
    : `[tool call: ${toolName}]`;

  return [header, formattedArgs].filter(Boolean).join("\n");
};

const extractMessageError = (message: any): string | undefined => {
  const errorMessage = typeof message?.errorMessage === "string" ? message.errorMessage.trim() : "";
  if (!errorMessage) return undefined;
  if (message?.stopReason === "aborted" && errorMessage === "Operation aborted") return undefined;

  const normalized = normalizeErrorMessage(errorMessage);
  return /^error:/i.test(normalized) ? normalized : `Error: ${normalized}`;
};

const normalizeErrorMessage = (errorMessage: string): string => {
  const trimmed = errorMessage.trim();
  const prefixMatch = trimmed.match(/^([^:]+error):\s*(\{[\s\S]+\})$/i);
  const jsonCandidate = prefixMatch?.[2] ?? (trimmed.startsWith("{") ? trimmed : undefined);

  if (!jsonCandidate) return trimmed;

  try {
    const parsed = JSON.parse(jsonCandidate);
    const nestedMessage =
      typeof parsed?.error?.message === "string"
        ? parsed.error.message
        : typeof parsed?.message === "string"
          ? parsed.message
          : undefined;

    if (!nestedMessage) return trimmed;
    if (!prefixMatch?.[1]) return nestedMessage;
    return `${prefixMatch[1]}: ${nestedMessage}`;
  } catch {
    return trimmed;
  }
};

const safeJson = (value: unknown): string => {
  const serialized = JSON.stringify(
    value,
    (key, currentValue) => {
      if (key === "data" && typeof currentValue === "string") {
        return `[base64:${currentValue.length}]`;
      }
      if (key === "content" && typeof currentValue === "string" && currentValue.length > MAX_JSON_PREVIEW) {
        return `${currentValue.slice(0, MAX_JSON_PREVIEW)}…`;
      }
      return currentValue;
    },
    2,
  );

  return serialized ?? "";
};
