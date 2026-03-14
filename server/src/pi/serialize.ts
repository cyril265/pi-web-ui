import type { ApiMessage, ApiModelInfo, ApiSessionSnapshot, ApiToolExecution, SessionStatus } from "@pi-web-app/shared";

const MAX_JSON_PREVIEW = 1_200;

export const serializeModel = (model: any): ApiModelInfo | undefined => {
  if (!model?.provider || !model?.id) return undefined;

  return {
    provider: String(model.provider),
    id: String(model.id),
    name: String(model.name ?? model.id),
  };
};

export const serializeMessages = (messages: any[] | undefined): ApiMessage[] => {
  if (!messages) return [];

  return messages
    .map((message, index) => ({
      id: String(message.id ?? `${message.role ?? "message"}-${index}`),
      role: String(message.role ?? "unknown"),
      text: extractMessageText(message),
      timestamp: message.timestamp ? String(message.timestamp) : undefined,
    }))
    .filter((message) => message.text.trim().length > 0);
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
    return summarize(firstUserMessage.text);
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

export const createSnapshot = (options: {
  session: any;
  sessionName: string | undefined;
  toolExecutions: Map<string, ApiToolExecution>;
  externallyDirty: boolean;
}): ApiSessionSnapshot => {
  const messages = serializeMessages(options.session.state?.messages);
  const sessionFile = options.session.sessionFile ? String(options.session.sessionFile) : undefined;

  return {
    sessionId: String(options.session.sessionId),
    sessionFile,
    title: deriveTitle({
      messages,
      sessionFile,
      sessionName: options.sessionName,
    }),
    status: extractStatus(options.session),
    live: true,
    externallyDirty: options.externallyDirty,
    model: serializeModel(options.session.model ?? options.session.state?.model),
    thinkingLevel: String(options.session.thinkingLevel ?? options.session.state?.thinkingLevel ?? "off"),
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
        if (part?.type === "thinking") return "";
        if (typeof part?.text === "string") return part.text;
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

const summarize = (text: string): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "New session";
  return normalized.length <= 72 ? normalized : `${normalized.slice(0, 69)}...`;
};

const formatToolCall = (toolCall: any): string => {
  const toolName = typeof toolCall?.name === "string" ? toolCall.name : "unknown";
  const args = toolCall?.arguments ?? toolCall?.partialJson;
  const formattedArgs = typeof args === "string" ? args : safeJson(args);

  return [`[tool call: ${toolName}]`, formattedArgs].filter(Boolean).join("\n");
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
