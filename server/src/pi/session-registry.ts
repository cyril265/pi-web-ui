import { existsSync, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type {
  ApiForkMessage,
  ApiImageInput,
  ApiModelInfo,
  ApiSessionListItem,
  ApiTreeMessage,
  ThinkingLevel,
} from "@pi-web-app/shared";
import { LiveSession } from "./live-session.js";
import { deriveTitle, extractMessageText, serializeModel } from "./serialize.js";

const INTERNAL_CHANGE_WINDOW_MS = 300;

type CreateAgentSessionResult = Awaited<ReturnType<typeof createAgentSession>>;
type AgentSession = CreateAgentSessionResult["session"];
type PiSessionManager = ReturnType<typeof SessionManager.create>;

export class SessionRegistry {
  private readonly authStorage;
  private readonly modelRegistry;
  private readonly liveSessions = new Map<string, LiveSession>();
  private readonly liveSessionsByPath = new Map<string, LiveSession>();
  private readonly sessionDir: string;

  constructor(
    readonly cwd: string,
    readonly agentDir = resolve(process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent")),
  ) {
    this.sessionDir = join(this.agentDir, "sessions");
    this.authStorage = AuthStorage.create(join(this.agentDir, "auth.json"));
    this.modelRegistry = new ModelRegistry(this.authStorage, join(this.agentDir, "models.json"));
    this.startWatchingSessionsDirectory();
  }

  async listSessions(scope: "current" | "all" = "current"): Promise<ApiSessionListItem[]> {
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

  async createSession() {
    const sessionManager = SessionManager.create(this.cwd, this.sessionDir);
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager,
    });

    const liveSession = await this.registerSession(session, sessionManager);
    this.pruneInactiveSessions([String(liveSession.session.sessionId)]);
    return liveSession;
  }

  async openSession(sessionFile: string) {
    return this.openSessionInternal(sessionFile, false);
  }

  activateSession(sessionId: string) {
    const liveSession = this.mustGetSession(sessionId);
    this.pruneInactiveSessions([String(liveSession.session.sessionId)]);
    return liveSession;
  }

  getLiveSession(sessionId: string) {
    return this.liveSessions.get(sessionId);
  }

  async getAvailableModels(): Promise<ApiModelInfo[]> {
    const models = await this.modelRegistry.getAvailable();
    return models
      .map((model) => serializeModel(model))
      .filter((model): model is ApiModelInfo => Boolean(model))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async prompt(sessionId: string, message: string, images: ApiImageInput[]) {
    const liveSession = this.mustGetSession(sessionId);
    await liveSession.session.prompt(message, images.length > 0 ? { images: images.map(toSdkImage) } : undefined);
  }

  async steer(sessionId: string, message: string) {
    const liveSession = this.mustGetSession(sessionId);
    await liveSession.session.steer(message);
  }

  async followUp(sessionId: string, message: string) {
    const liveSession = this.mustGetSession(sessionId);
    await liveSession.session.followUp(message);
  }

  async abort(sessionId: string) {
    const liveSession = this.mustGetSession(sessionId);
    await liveSession.session.abort();
    liveSession.publishSnapshot();
  }

  async cycleModel(sessionId: string) {
    const liveSession = this.mustGetSession(sessionId);
    await liveSession.session.cycleModel();
    liveSession.publishSnapshot();
  }

  async setModel(sessionId: string, provider: string, modelId: string) {
    const liveSession = this.mustGetSession(sessionId);
    const model = this.modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(`Model not found: ${provider}/${modelId}`);
    }

    await liveSession.session.setModel(model);
    liveSession.publishSnapshot();
  }

  setThinkingLevel(sessionId: string, thinkingLevel: ThinkingLevel) {
    const liveSession = this.mustGetSession(sessionId);
    liveSession.session.setThinkingLevel(thinkingLevel);
    liveSession.publishSnapshot();
  }

  renameSession(sessionId: string, name: string) {
    const liveSession = this.mustGetSession(sessionId);
    liveSession.sessionManager.appendSessionInfo(name.trim());
    liveSession.publishSnapshot();
    return liveSession;
  }

  getForkMessages(sessionId: string): ApiForkMessage[] {
    return this.getUserMessages(sessionId).map((entry) => ({
      entryId: entry.entryId,
      text: entry.text,
    }));
  }

  getTreeMessages(sessionId: string): ApiTreeMessage[] {
    return this.getUserMessages(sessionId);
  }

  async fork(sessionId: string, entryId: string) {
    const liveSession = this.mustGetSession(sessionId);
    const previousSessionId = String(liveSession.session.sessionId);
    const previousSessionFile = liveSession.session.sessionFile ? String(liveSession.session.sessionFile) : undefined;
    const result = await liveSession.session.fork(entryId);

    this.syncLiveSessionIdentity(liveSession, previousSessionId, previousSessionFile);
    liveSession.resetAfterSessionMutation();

    return {
      liveSession,
      selectedText: result.selectedText,
      cancelled: result.cancelled,
    };
  }

  async navigateTree(sessionId: string, entryId: string) {
    const liveSession = this.mustGetSession(sessionId);
    const result = await liveSession.session.navigateTree(entryId);

    liveSession.resetAfterSessionMutation();

    return {
      liveSession,
      editorText: result.editorText,
      cancelled: result.cancelled,
    };
  }

  async reopenSession(sessionId: string) {
    const liveSession = this.mustGetSession(sessionId);
    const sessionFile = liveSession.session.sessionFile ? String(liveSession.session.sessionFile) : undefined;
    if (!sessionFile) {
      throw new Error("Only persisted sessions can be reloaded from disk.");
    }

    this.unregisterLiveSession(liveSession);
    liveSession.dispose();

    return this.openSessionInternal(sessionFile, true);
  }

  respondToUiRequest(sessionId: string, response: { id: string; value: string | undefined; confirmed: boolean | undefined; cancelled: boolean | undefined; }) {
    const liveSession = this.mustGetSession(sessionId);
    liveSession.respondToUiRequest(response);
  }

  disposeIfInactive(sessionId: string) {
    const liveSession = this.liveSessions.get(sessionId);
    if (!liveSession || !this.isInactiveLiveSession(liveSession)) {
      return;
    }

    this.unregisterLiveSession(liveSession);
    liveSession.dispose();
  }

  private mustGetSession(sessionId: string) {
    const liveSession = this.liveSessions.get(sessionId);
    if (!liveSession) {
      throw new Error(`Live session not found: ${sessionId}`);
    }
    return liveSession;
  }

  private async openSessionInternal(sessionFile: string, forceReload: boolean) {
    const existing = this.liveSessionsByPath.get(sessionFile);
    if (existing && !forceReload) {
      this.pruneInactiveSessions([String(existing.session.sessionId)]);
      return existing;
    }

    if (existing && forceReload) {
      this.unregisterLiveSession(existing);
      existing.dispose();
    }

    const sessionManager = SessionManager.open(sessionFile);
    const sessionHeader = sessionManager.getHeader?.();
    const sessionCwd = typeof sessionHeader?.cwd === "string" ? sessionHeader.cwd : undefined;
    const { session } = await createAgentSession({
      cwd: typeof sessionCwd === "string" ? resolve(sessionCwd) : this.cwd,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager,
    });

    const liveSession = await this.registerSession(session, sessionManager);
    this.pruneInactiveSessions([String(liveSession.session.sessionId)]);
    return liveSession;
  }

  private async listAllSessions() {
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

  private getUserMessages(sessionId: string): ApiTreeMessage[] {
    const liveSession = this.mustGetSession(sessionId);
    const currentLeafId = liveSession.sessionManager.getLeafId?.();
    const currentBranchEntryIds = currentLeafId
      ? new Set(liveSession.sessionManager.getBranch(currentLeafId).map((entry: any) => String(entry.id)))
      : new Set<string>();

    return liveSession.sessionManager
      .getEntries()
      .filter((entry: any) => entry.type === "message")
      .map((entry: any) => ({
        entryId: String(entry.id),
        role: entry.message?.role,
        text: extractMessageText(entry.message),
        isOnCurrentPath: currentBranchEntryIds.has(String(entry.id)),
      }))
      .filter((entry: { role: string | undefined; text: string }) =>
        (entry.role === "user" || entry.role === "user-with-attachments") && entry.text.trim().length > 0,
      )
      .map((entry: { entryId: string; text: string; isOnCurrentPath: boolean }) => ({
        entryId: entry.entryId,
        text: entry.text,
        isOnCurrentPath: entry.isOnCurrentPath,
      }))
      .reverse();
  }

  private toSessionListItem(sessionInfo: {
    id: string;
    path: string;
    cwd: string | undefined;
    name: string | undefined;
    firstMessage: string | undefined;
    modified: number | string | Date | undefined;
    messageCount: number | undefined;
  }): ApiSessionListItem {
    const liveSession = this.liveSessionsByPath.get(sessionInfo.path);
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

  private async registerSession(session: AgentSession, sessionManager: PiSessionManager) {
    const liveSession = new LiveSession(session, sessionManager);
    this.liveSessions.set(String(session.sessionId), liveSession);

    if (session.sessionFile) {
      this.liveSessionsByPath.set(String(session.sessionFile), liveSession);
    }

    await liveSession.session.bindExtensions({
      uiContext: liveSession.createExtensionUiContext(),
      commandContextActions: {
        waitForIdle: () => liveSession.session.agent.waitForIdle(),
        newSession: async (options: any) => {
          const previousSessionId = String(liveSession.session.sessionId);
          const previousSessionFile = liveSession.session.sessionFile ? String(liveSession.session.sessionFile) : undefined;
          const success = await liveSession.session.newSession(options);
          if (success) {
            this.syncLiveSessionIdentity(liveSession, previousSessionId, previousSessionFile);
            liveSession.resetAfterSessionMutation();
          }
          return { cancelled: !success };
        },
        fork: async (entryId: string) => {
          const previousSessionId = String(liveSession.session.sessionId);
          const previousSessionFile = liveSession.session.sessionFile ? String(liveSession.session.sessionFile) : undefined;
          const result = await liveSession.session.fork(entryId);
          this.syncLiveSessionIdentity(liveSession, previousSessionId, previousSessionFile);
          liveSession.resetAfterSessionMutation();
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId: string, options: any) => {
          const result = await liveSession.session.navigateTree(targetId, options);
          liveSession.resetAfterSessionMutation();
          return { cancelled: result.cancelled };
        },
        switchSession: async (sessionPath: string) => {
          const previousSessionId = String(liveSession.session.sessionId);
          const previousSessionFile = liveSession.session.sessionFile ? String(liveSession.session.sessionFile) : undefined;
          const success = await liveSession.session.switchSession(sessionPath);
          if (success) {
            this.syncLiveSessionIdentity(liveSession, previousSessionId, previousSessionFile);
            liveSession.resetAfterSessionMutation();
          }
          return { cancelled: !success };
        },
        reload: async () => {
          await liveSession.session.reload();
          liveSession.publishSnapshot();
        },
      },
      shutdownHandler: () => {},
      onError: (error: { error: string }) => {
        liveSession.publish({
          type: "error",
          message: error.error,
        });
      },
    });

    return liveSession;
  }

  private unregisterLiveSession(liveSession: LiveSession) {
    this.liveSessions.delete(String(liveSession.session.sessionId));
    if (liveSession.session.sessionFile) {
      this.liveSessionsByPath.delete(String(liveSession.session.sessionFile));
    }
  }

  private syncLiveSessionIdentity(
    liveSession: LiveSession,
    previousSessionId: string,
    previousSessionFile: string | undefined,
  ) {
    this.liveSessions.delete(previousSessionId);
    if (previousSessionFile) {
      this.liveSessionsByPath.delete(previousSessionFile);
    }

    this.liveSessions.set(String(liveSession.session.sessionId), liveSession);
    if (liveSession.session.sessionFile) {
      this.liveSessionsByPath.set(String(liveSession.session.sessionFile), liveSession);
    }
  }

  private pruneInactiveSessions(keepSessionIds: Iterable<string>) {
    const keep = new Set([...keepSessionIds].map(String));
    const staleSessions = [...this.liveSessions.entries()]
      .filter(([sessionId, liveSession]) => !keep.has(sessionId) && this.isInactiveLiveSession(liveSession))
      .map(([, liveSession]) => liveSession);

    for (const liveSession of staleSessions) {
      this.unregisterLiveSession(liveSession);
      liveSession.dispose();
    }
  }

  private isInactiveLiveSession(liveSession: LiveSession) {
    return liveSession.subscribers.size === 0 && !Boolean(liveSession.session.isStreaming);
  }

  private startWatchingSessionsDirectory() {
    if (!existsSync(this.sessionDir)) {
      return;
    }

    watch(this.sessionDir, { recursive: true }, (_eventType, fileName) => {
      if (!fileName) return;
      const changedPath = join(this.sessionDir, fileName.toString());
      const liveSession = this.liveSessionsByPath.get(changedPath);
      if (!liveSession) return;
      if (Date.now() - liveSession.lastInternalUpdateAt <= INTERNAL_CHANGE_WINDOW_MS) return;
      liveSession.markExternalChange();
    });
  }
}

const toSdkImage = (image: ApiImageInput) => ({
  type: "image" as const,
  source: {
    type: "base64" as const,
    mediaType: image.mimeType,
    data: image.data,
  },
});
