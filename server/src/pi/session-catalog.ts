import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ApiSessionListItem } from "@pi-web-app/shared";
import { deriveTitle, extractMessageText } from "./serialize.js";

export type SessionListScope = "current" | "all";

type ListedSessionInfo = {
  id: string;
  path: string;
  cwd: string | undefined;
  name: string | undefined;
  firstMessage: string | undefined;
  modified: number | string | Date | undefined;
  messageCount: number | undefined;
};

type SessionCatalogLiveSession = {
  externallyDirty: boolean;
  getSessionName(): string | undefined;
  session: {
    sessionId: unknown;
    model?: { id?: string | undefined } | undefined;
    thinkingLevel: unknown;
    isStreaming?: boolean | undefined;
  };
};

export class SessionCatalog {
  constructor(
    private readonly cwd: string,
    private readonly sessionDir: string,
    private readonly getLiveSessionForFile: (sessionFile: string) => SessionCatalogLiveSession | undefined,
  ) {}

  async listSessions(scope: SessionListScope = "current"): Promise<ApiSessionListItem[]> {
    const listed = scope === "all"
      ? await this.listAllSessions()
      : await SessionManager.list(this.cwd, this.sessionDir);

    return listed
      .map((sessionInfo) =>
        this.toSessionListItem({
          id: String(sessionInfo.id),
          path: sessionInfo.path,
          cwd: sessionInfo.cwd ? String(sessionInfo.cwd) : undefined,
          name: sessionInfo.name ? String(sessionInfo.name) : undefined,
          firstMessage: sessionInfo.firstMessage ? String(sessionInfo.firstMessage) : undefined,
          modified: sessionInfo.modified,
          messageCount: sessionInfo.messageCount,
        }),
      )
      .sort((left, right) => (right.lastModified ?? "").localeCompare(left.lastModified ?? ""));
  }

  private async listAllSessions(): Promise<ListedSessionInfo[]> {
    const sessionFiles = await this.getSessionFiles(this.sessionDir);

    return Promise.all(
      sessionFiles.map(async (sessionFile) => {
        const sessionManager = SessionManager.open(sessionFile);
        const entries = sessionManager.getEntries();
        const header = sessionManager.getHeader?.();
        const firstUserEntry = entries.find(
          (entry: any) =>
            entry.type === "message" &&
            (entry.message?.role === "user" || entry.message?.role === "user-with-attachments"),
        ) as any;
        const firstUserMessage = firstUserEntry?.message;
        const sessionStats = await stat(sessionFile);

        return {
          id: String(sessionManager.getSessionId()),
          path: sessionFile,
          cwd: typeof header?.cwd === "string" ? header.cwd : undefined,
          name: sessionManager.getSessionName?.(),
          firstMessage: firstUserMessage ? extractMessageText(firstUserMessage) : "",
          modified: sessionStats.mtimeMs,
          messageCount: entries.filter((entry: any) => entry.type === "message").length,
        };
      }),
    );
  }

  private async getSessionFiles(directory: string): Promise<string[]> {
    if (!existsSync(directory)) {
      return [];
    }

    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          return this.getSessionFiles(fullPath);
        }
        return fullPath.endsWith(".jsonl") ? [fullPath] : [];
      }),
    );

    return files.flat();
  }

  private toSessionListItem(sessionInfo: ListedSessionInfo): ApiSessionListItem {
    const liveSession = this.getLiveSessionForFile(sessionInfo.path);
    const sessionName = sessionInfo.name ? String(sessionInfo.name) : liveSession?.getSessionName();
    const sessionCwd = sessionInfo.cwd ? String(sessionInfo.cwd) : undefined;

    return {
      id: liveSession ? String(liveSession.session.sessionId) : String(sessionInfo.id),
      sessionFile: sessionInfo.path,
      cwd: sessionCwd,
      isInCurrentWorkspace: this.isCurrentWorkspace(sessionCwd),
      title: deriveTitle({
        messages: sessionInfo.firstMessage
          ? [{ id: "preview", role: "user", text: sessionInfo.firstMessage, timestamp: undefined }]
          : [],
        sessionFile: sessionInfo.path,
        sessionName,
      }),
      preview: String(sessionInfo.firstMessage ?? ""),
      lastModified: sessionInfo.modified ? new Date(sessionInfo.modified).toISOString() : undefined,
      messageCount: Number(sessionInfo.messageCount ?? 0),
      modelId: liveSession?.session.model?.id,
      thinkingLevel: liveSession ? String(liveSession.session.thinkingLevel) : undefined,
      status: liveSession?.session.isStreaming ? "streaming" : "idle",
      live: Boolean(liveSession),
      externallyDirty: liveSession?.externallyDirty ?? false,
    };
  }

  private isCurrentWorkspace(sessionCwd: string | undefined) {
    if (!sessionCwd) return false;
    return resolve(sessionCwd) === this.cwd;
  }
}
