import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type {
  ApiExtensionNotification,
  ApiExtensionStatusEntry,
  ApiExtensionSurface,
  ApiExtensionUiRequest,
  ApiExtensionUiResponse,
  ApiExtensionWidget,
  SessionEvent,
} from "@pi-web-app/shared";

type ExtensionUiEventType =
  | "extension_ui_request"
  | "extension_notify"
  | "set_status"
  | "set_widget"
  | "set_header"
  | "set_footer";

type ExtensionUiEvent = Extract<SessionEvent, { type: ExtensionUiEventType }>;

type ExtensionUiResponseDraft = {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
};

type ExtensionUiOptions = {
  getSessionId: () => string | undefined;
  requestRender: () => void;
  submitResponse: (sessionId: string, response: ApiExtensionUiResponse) => Promise<void>;
};

type AnsiStyleState = {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
};

const EXTENSION_NOTIFICATION_DEDUPE_WINDOW_MS = 3_000;

export class ExtensionUi {
  private pendingRequest: ApiExtensionUiRequest | undefined;
  private requestValue = "";
  private notifications: ApiExtensionNotification[] = [];
  private statuses: ApiExtensionStatusEntry[] = [];
  private widgets: ApiExtensionWidget[] = [];
  private header: ApiExtensionSurface | undefined;
  private footer: ApiExtensionSurface | undefined;
  private readonly recentNotifications = new Map<string, number>();

  constructor(private readonly options: ExtensionUiOptions) {}

  applyEvent(event: ExtensionUiEvent) {
    switch (event.type) {
      case "extension_ui_request":
        this.pendingRequest = event.request;
        this.requestValue = event.request.prefill ?? "";
        break;
      case "extension_notify":
        this.pushNotification(event.notification);
        break;
      case "set_status":
        this.setStatus(event.key, event.text);
        break;
      case "set_widget":
        this.setWidget(event.key, event.widget);
        break;
      case "set_header":
        this.header = event.header;
        break;
      case "set_footer":
        this.footer = event.footer;
        break;
    }
  }

  clearForSessionChange() {
    this.pendingRequest = undefined;
    this.requestValue = "";
    this.statuses = [];
    this.widgets = [];
    this.header = undefined;
    this.footer = undefined;
  }

  hasFooter() {
    return this.footer !== undefined;
  }

  renderToasts() {
    if (this.notifications.length === 0) return nothing;
    return html`
      <div class="pp-toasts">
        ${this.notifications.map((notification) => html`
          <div class="pp-toast ${notification.notifyType}">
            <div class="pp-toast-type">${notification.notifyType}</div>
            <div>${notification.message}</div>
          </div>
        `)}
      </div>
    `;
  }

  renderHeader() {
    return renderExtensionSurface(this.header, "header");
  }

  renderFooter() {
    return renderExtensionSurface(this.footer, "footer");
  }

  renderWidgets(placement: ApiExtensionWidget["placement"]) {
    const widgets = this.widgets.filter((widget) => widget.placement === placement);
    if (widgets.length === 0) return nothing;
    return html`
      <div style="padding:0 1rem;">
        ${widgets.map(
          (widget) => html`
            <div style="margin-bottom:0.5rem;padding:0.5rem 0.75rem;border:1px solid var(--pp-border);border-radius:0.375rem;background:var(--pp-bg-secondary);">
              <div style="font-size:0.625rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--pp-text-muted);margin-bottom:0.25rem;">${widget.key}</div>
              <pre style="font-size:0.75rem;line-height:1.5;color:var(--pp-text-muted);white-space:pre-wrap;word-break:break-word;margin:0;">${unsafeHTML(renderAnsiHtml(widget.lines.join("\n")))}</pre>
            </div>
          `,
        )}
      </div>
    `;
  }

  renderStatuses() {
    return html`${this.statuses.map(
      (status) => html`<span style="font-size:0.6875rem;">${status.key}: ${renderAnsiText(status.text, "pp-ansi-inline")}</span>`,
    )}`;
  }

  renderDialog() {
    if (!this.pendingRequest) return nothing;
    const request = this.pendingRequest;
    return html`
      <div class="pp-dialog-overlay" @click=${() => void this.submitResponse({ cancelled: true })}>
        <div class="pp-dialog" @click=${(event: Event) => event.stopPropagation()}>
          <div class="pp-dialog-title">${request.title}</div>
          ${request.message ? html`<div class="pp-dialog-subtitle">${request.message}</div>` : nothing}
          ${request.timeout
            ? html`<div style="font-size:0.75rem;color:var(--pp-text-muted);margin-bottom:0.5rem;">Expires in ~${Math.ceil(request.timeout / 1000)}s</div>`
            : nothing}

          ${request.method === "select"
            ? html`${request.options?.map(
                (option) => html`
                  <button class="pp-dialog-item" @click=${() => void this.submitResponse({ value: option })}>
                    ${option}
                  </button>
                `,
              )}`
            : nothing}

          ${request.method === "confirm"
            ? html`
                <div style="display:flex;gap:0.375rem;">
                  <button class="pp-dialog-btn" style="flex:1;" @click=${() => void this.submitResponse({ cancelled: true })}>Cancel</button>
                  <button class="pp-dialog-btn primary" style="flex:1;" @click=${() => void this.submitResponse({ confirmed: true })}>Confirm</button>
                </div>
              `
            : nothing}

          ${request.method === "input" || request.method === "editor"
            ? html`
                ${request.method === "input"
                  ? html`<input
                      class="pp-dialog-input"
                      style="margin-bottom:0.5rem;"
                      .value=${this.requestValue}
                      @input=${(event: Event) => this.handleValueInput(event)}
                      placeholder=${request.placeholder ?? ""}
                    />`
                  : html`<textarea
                      class="pp-dialog-input"
                      style="margin-bottom:0.5rem;min-height:10rem;font-family:monospace;"
                      .value=${this.requestValue}
                      @input=${(event: Event) => this.handleValueInput(event)}
                      placeholder=${request.placeholder ?? ""}
                    ></textarea>`}
                <div style="display:flex;gap:0.375rem;">
                  <button class="pp-dialog-btn" style="flex:1;" @click=${() => void this.submitResponse({ cancelled: true })}>Cancel</button>
                  <button class="pp-dialog-btn primary" style="flex:1;" @click=${() => void this.submitResponse({ value: this.requestValue })}>Submit</button>
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  private pushNotification(notification: ApiExtensionNotification) {
    const notificationKey = `${notification.notifyType}:${notification.message}`;
    const now = Date.now();
    const lastShownAt = this.recentNotifications.get(notificationKey);
    if (lastShownAt !== undefined && now - lastShownAt < EXTENSION_NOTIFICATION_DEDUPE_WINDOW_MS) {
      return;
    }

    this.recentNotifications.set(notificationKey, now);
    setTimeout(() => {
      if (this.recentNotifications.get(notificationKey) === now) {
        this.recentNotifications.delete(notificationKey);
      }
    }, EXTENSION_NOTIFICATION_DEDUPE_WINDOW_MS).unref?.();

    this.notifications = [notification, ...this.notifications].slice(0, 4);
    setTimeout(() => {
      this.notifications = this.notifications.filter((entry) => entry.id !== notification.id);
      this.options.requestRender();
    }, 6_000).unref?.();
  }

  private setStatus(key: string, text: string | undefined) {
    this.statuses = text
      ? [{ key, text }, ...this.statuses.filter((entry) => entry.key !== key)]
      : this.statuses.filter((entry) => entry.key !== key);
  }

  private setWidget(key: string, widget: unknown) {
    const normalizedWidget = normalizeExtensionWidget(key, widget);
    this.widgets = normalizedWidget
      ? [normalizedWidget, ...this.widgets.filter((entry) => entry.key !== key)]
      : this.widgets.filter((entry) => entry.key !== key);
  }

  private handleValueInput(event: Event) {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      this.requestValue = target.value;
    }
  }

  private async submitResponse(response: ExtensionUiResponseDraft) {
    const sessionId = this.options.getSessionId();
    if (!sessionId || !this.pendingRequest) return;

    const requestId = this.pendingRequest.id;
    this.pendingRequest = undefined;
    this.options.requestRender();

    await this.options.submitResponse(sessionId, {
      id: requestId,
      value: response.value,
      confirmed: response.confirmed,
      cancelled: response.cancelled,
    });
  }
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

function renderExtensionSurface(surface: ApiExtensionSurface | undefined, kind: "header" | "footer") {
  if (!surface || surface.lines.length === 0) return nothing;
  return html`
    <div class="pp-extension-surface pp-extension-surface-${kind}">
      <pre>${unsafeHTML(renderAnsiHtml(surface.lines.join("\n")))}</pre>
    </div>
  `;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeAnsiHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function ansi16ColorToCss(code: number) {
  const colors = [
    "#000000",
    "#cd3131",
    "#0dbc79",
    "#e5e510",
    "#2472c8",
    "#bc3fbc",
    "#11a8cd",
    "#e5e5e5",
    "#666666",
    "#f14c4c",
    "#23d18b",
    "#f5f543",
    "#3b8eea",
    "#d670d6",
    "#29b8db",
    "#ffffff",
  ];
  const color = colors[code];
  if (!color) throw new Error(`Unsupported ANSI color code: ${code}`);
  return color;
}

function ansi256ColorToCss(code: number) {
  if (code < 0 || code > 255) return undefined;
  if (code < 16) return ansi16ColorToCss(code);
  if (code >= 232) {
    const channel = 8 + ((code - 232) * 10);
    return `rgb(${channel}, ${channel}, ${channel})`;
  }

  const index = code - 16;
  const red = Math.floor(index / 36);
  const green = Math.floor((index % 36) / 6);
  const blue = index % 6;
  const toChannel = (value: number) => value === 0 ? 0 : (value * 40) + 55;
  return `rgb(${toChannel(red)}, ${toChannel(green)}, ${toChannel(blue)})`;
}

function parseAnsiColor(params: number[], index: number) {
  const mode = params[index + 1];
  if (mode === 5) {
    const code = params[index + 2];
    return {
      color: typeof code === "number" ? ansi256ColorToCss(code) : undefined,
      nextIndex: index + 2,
    };
  }

  if (mode === 2) {
    const red = params[index + 2];
    const green = params[index + 3];
    const blue = params[index + 4];
    const isValid = [red, green, blue].every((value) => typeof value === "number" && value >= 0 && value <= 255);
    return {
      color: isValid ? `rgb(${red}, ${green}, ${blue})` : undefined,
      nextIndex: index + 4,
    };
  }

  return {
    color: undefined,
    nextIndex: index,
  };
}

function ansiStyleToCss(style: AnsiStyleState) {
  const rules = [
    style.fg ? `color:${style.fg}` : undefined,
    style.bg ? `background-color:${style.bg}` : undefined,
    style.bold ? "font-weight:600" : undefined,
    style.dim ? "opacity:0.72" : undefined,
    style.italic ? "font-style:italic" : undefined,
    style.underline ? "text-decoration:underline" : undefined,
  ].filter((value): value is string => Boolean(value));

  return rules.join(";");
}

function renderAnsiHtml(text: string) {
  const pattern = /\x1b\[([0-9;]*)m/g;
  const style: AnsiStyleState = {};
  let cursor = 0;
  let result = "";

  const appendChunk = (chunk: string) => {
    if (!chunk) return;
    const escaped = escapeAnsiHtml(chunk);
    const css = ansiStyleToCss(style);
    result += css ? `<span style="${css}">${escaped}</span>` : escaped;
  };

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    appendChunk(text.slice(cursor, index));
    cursor = index + match[0].length;

    const params = match[1]
      ? match[1].split(";").map((value) => Number.parseInt(value, 10)).filter((value) => Number.isFinite(value))
      : [0];

    for (let paramIndex = 0; paramIndex < params.length; paramIndex += 1) {
      const code = params[paramIndex] ?? 0;
      switch (code) {
        case 0:
          delete style.fg;
          delete style.bg;
          delete style.bold;
          delete style.dim;
          delete style.italic;
          delete style.underline;
          break;
        case 1:
          style.bold = true;
          break;
        case 2:
          style.dim = true;
          break;
        case 3:
          style.italic = true;
          break;
        case 4:
          style.underline = true;
          break;
        case 22:
          delete style.bold;
          delete style.dim;
          break;
        case 23:
          delete style.italic;
          break;
        case 24:
          delete style.underline;
          break;
        case 39:
          delete style.fg;
          break;
        case 49:
          delete style.bg;
          break;
        default:
          if (code >= 30 && code <= 37) {
            style.fg = ansi16ColorToCss(code - 30);
            break;
          }
          if (code >= 90 && code <= 97) {
            style.fg = ansi16ColorToCss((code - 90) + 8);
            break;
          }
          if (code >= 40 && code <= 47) {
            style.bg = ansi16ColorToCss(code - 40);
            break;
          }
          if (code >= 100 && code <= 107) {
            style.bg = ansi16ColorToCss((code - 100) + 8);
            break;
          }
          if (code === 38 || code === 48) {
            const { color, nextIndex } = parseAnsiColor(params, paramIndex);
            if (code === 38) {
              if (color) {
                style.fg = color;
              } else {
                delete style.fg;
              }
            } else if (color) {
              style.bg = color;
            } else {
              delete style.bg;
            }
            paramIndex = nextIndex;
          }
          break;
      }
    }
  }

  appendChunk(text.slice(cursor));
  return result;
}

function renderAnsiText(text: string, className = "") {
  return html`<span class=${className}>${unsafeHTML(renderAnsiHtml(text))}</span>`;
}
