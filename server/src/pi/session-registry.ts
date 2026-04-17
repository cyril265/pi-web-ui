import { existsSync, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { BUILTIN_SLASH_COMMANDS } from "@pi-web-app/shared";
import type {
  ApiForkMessage,
  ApiImageInput,
  ApiModelInfo,
  ApiSlashCommand,
  ApiSessionListItem,
  ApiTreeMessage,
  ThinkingLevel,
} from "@pi-web-app/shared";
import { bindSessionExtensions, getRegisteredExtensionCommands } from "./extension-bridge.js";
import { GlobalMutationTracker } from "./global-mutation-tracker.js";
import { LiveSession } from "./live-session.js";
import { deriveTitle, extractMessageText, serializeModel } from "./serialize.js";

const INTERNAL_CHANGE_WINDOW_MS = 5_000;
const LIVE_SESSION_DISPOSE_DELAY_MS = 30_000;

const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const normalizeSlashCommandLocation = (source: unknown): ApiSlashCommand["location"] =>
  source === "user" || source === "project" || source === "path" ? source : undefined;

const createSlashCommand = (
  command: Pick<ApiSlashCommand, "name" | "source"> & {
    description?: string | undefined;
    location?: ApiSlashCommand["location"] | undefined;
    path?: string | undefined;
  },
): ApiSlashCommand => ({
  name: command.name,
  source: command.source,
  ...(command.description ? { description: command.description } : {}),
  ...(command.location ? { location: command.location } : {}),
  ...(command.path ? { path: command.path } : {}),
});

type CreateAgentSessionResult = Awaited<ReturnType<typeof createAgentSession>>;
type AgentSession = CreateAgentSessionResult["session"];
type PiSessionManager = ReturnType<typeof SessionManager.create>;

export class SessionRegistry {
  private readonly authStorage;
  private readonly modelRegistry;
  private readonly liveSessions = new Map<string, LiveSession>();
  private readonly liveSessionsByPath = new Map<string, LiveSession>();
  private readonly scheduledSessionDisposals = new Map<string, ReturnType<typeof setTimeout>>();
  private activeGlobalSessionId: string | undefined;
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

  async createSession(targetCwd = this.cwd) {
    const resolvedCwd = resolve(this.cwd, targetCwd);
    const targetStats = await stat(resolvedCwd).catch(() => undefined);
    if (!targetStats?.isDirectory()) {
      throw new Error(`Directory not found: ${resolvedCwd}`);
    }

    const sessionManager = SessionManager.create(resolvedCwd, this.sessionDir);
    const { session, globalMutationTracker } = await this.createSdkSession(resolvedCwd, sessionManager);

    const liveSession = await this.registerSession(session, sessionManager, globalMutationTracker, {
      suppressNotifications: false,
    });
    this.activateLiveSessionGlobals(liveSession);
    this.pruneInactiveSessions([String(liveSession.session.sessionId)]);
    return liveSession;
  }

  async openSession(sessionFile: string) {
    return this.openSessionInternal(sessionFile, false);
  }

  activateSession(sessionId: string) {
    const liveSession = this.mustGetSession(sessionId);
    this.activateLiveSessionGlobals(liveSession);
    this.pruneInactiveSessions([String(liveSession.session.sessionId)]);
    return liveSession;
  }

  getLiveSession(sessionId: string) {
    const liveSession = this.liveSessions.get(sessionId);
    if (liveSession) {
      this.cancelScheduledSessionDisposal(sessionId);
      this.activateLiveSessionGlobals(liveSession);
    }
    return liveSession;
  }

  async getAvailableModels(): Promise<ApiModelInfo[]> {
    const models = await this.modelRegistry.getAvailable();
    return models
      .map((model) => serializeModel(model))
      .filter((model): model is ApiModelInfo => Boolean(model))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getSlashCommands(sessionId: string): Promise<ApiSlashCommand[]> {
    const liveSession = this.mustGetSession(sessionId);
    const reservedBuiltins = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));

    const registeredExtensionCommands = getRegisteredExtensionCommands(liveSession.session);
    const extensionCommands: ApiSlashCommand[] = registeredExtensionCommands
      .filter(({ command }) => !reservedBuiltins.has(command.name))
      .map(({ command, extensionPath }) =>
        createSlashCommand({
          name: command.name,
          description: command.description,
          source: "extension",
          path: extensionPath,
        }),
      );

    const resourceLoader = new DefaultResourceLoader({
      cwd: this.getSessionCwd(liveSession),
      agentDir: this.agentDir,
    });
    await resourceLoader.reload();

    const promptCommands: ApiSlashCommand[] = resourceLoader.getPrompts().prompts.map((template) =>
      createSlashCommand({
        name: template.name,
        description: template.description,
        source: "prompt",
        location: normalizeSlashCommandLocation(template.source),
        path: template.filePath,
      }),
    );

    const skillCommands: ApiSlashCommand[] = resourceLoader.getSkills().skills.map((skill) =>
      createSlashCommand({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill",
        location: normalizeSlashCommandLocation(skill.source),
        path: skill.filePath,
      }),
    );

    return [...BUILTIN_SLASH_COMMANDS, ...extensionCommands, ...promptCommands, ...skillCommands];
  }

  prompt(sessionId: string, message: string, images: ApiImageInput[]) {
    const liveSession = this.mustGetSession(sessionId);
    this.prepareForSessionMutation(liveSession);
    void liveSession.session.prompt(message, images.length > 0 ? { images: images.map(toSdkImage) } : undefined)
      .catch((error: unknown) => {
        liveSession.publish({
          type: "error",
          message: getErrorMessage(error),
        });
        liveSession.publishSnapshot();
      });
  }

  steer(sessionId: string, message: string) {
    const liveSession = this.mustGetSession(sessionId);
    this.prepareForSessionMutation(liveSession);
    void liveSession.session.steer(message).catch((error: unknown) => {
      liveSession.publish({
        type: "error",
        message: getErrorMessage(error),
      });
      liveSession.publishSnapshot();
    });
  }

  followUp(sessionId: string, message: string) {
    const liveSession = this.mustGetSession(sessionId);
    this.prepareForSessionMutation(liveSession);
    void liveSession.session.followUp(message).catch((error: unknown) => {
      liveSession.publish({
        type: "error",
        message: getErrorMessage(error),
      });
      liveSession.publishSnapshot();
    });
  }

  async abort(sessionId: string) {
    const liveSession = this.mustGetSession(sessionId);
    this.prepareForSessionMutation(liveSession);
    await liveSession.session.abort();
    liveSession.publishSessionPatch();
  }

  async cycleModel(sessionId: string) {
    const liveSession = this.mustGetSession(sessionId);
    this.prepareForSessionMutation(liveSession);
    await liveSession.session.cycleModel();
    liveSession.publishSessionPatch();
  }

  async setModel(sessionId: string, provider: string, modelId: string) {
    const liveSession = this.mustGetSession(sessionId);
    const model = this.modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(`Model not found: ${provider}/${modelId}`);
    }

    this.prepareForSessionMutation(liveSession);
    await liveSession.session.setModel(model);
    liveSession.publishSessionPatch();
  }

  async compactSession(sessionId: string, instructions?: string) {
    const liveSession = this.mustGetSession(sessionId);
    this.prepareForSessionMutation(liveSession);
    await liveSession.session.compact(instructions);
    liveSession.publishSnapshot();
    return liveSession;
  }

  setThinkingLevel(sessionId: string, thinkingLevel: ThinkingLevel) {
    const liveSession = this.mustGetSession(sessionId);
    this.prepareForSessionMutation(liveSession);
    liveSession.session.setThinkingLevel(thinkingLevel);
    liveSession.publishSessionPatch();
  }

  renameSession(sessionId: string, name: string) {
    const liveSession = this.mustGetSession(sessionId);
    this.prepareForSessionMutation(liveSession);
    liveSession.sessionManager.appendSessionInfo(name.trim());
    liveSession.publishSessionPatch();
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
    this.prepareForSessionMutation(liveSession);
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
    this.prepareForSessionMutation(liveSession);
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
    this.prepareForSessionMutation(liveSession);
    const sessionFile = liveSession.session.sessionFile ? String(liveSession.session.sessionFile) : undefined;
    if (!sessionFile) {
      throw new Error("Only persisted sessions can be reloaded from disk.");
    }

    this.unregisterLiveSession(liveSession);
    liveSession.dispose();

    return this.openSessionInternal(sessionFile, true);
  }

  async reloadSession(sessionId: string) {
    const liveSession = this.mustGetSession(sessionId);
    this.prepareForSessionMutation(liveSession);
    await this.reloadLiveSessionFromDisk(liveSession);
    liveSession.publishSnapshot();
    return liveSession;
  }

  respondToUiRequest(sessionId: string, response: { id: string; value: string | undefined; confirmed: boolean | undefined; cancelled: boolean | undefined; }) {
    const liveSession = this.mustGetSession(sessionId);
    this.prepareForSessionMutation(liveSession);
    liveSession.respondToUiRequest(response);
  }

  disposeIfInactive(sessionId: string) {
    this.scheduleSessionDisposal(sessionId);
  }

  private mustGetSession(sessionId: string) {
    const liveSession = this.liveSessions.get(sessionId);
    if (!liveSession) {
      throw new Error(`Live session not found: ${sessionId}`);
    }

    this.cancelScheduledSessionDisposal(sessionId);
    return liveSession;
  }

  private getSessionCwd(liveSession: LiveSession) {
    const sessionHeader = liveSession.sessionManager.getHeader?.();
    if (typeof sessionHeader?.cwd === "string" && sessionHeader.cwd.trim()) {
      return resolve(sessionHeader.cwd);
    }

    return this.cwd;
  }

  private prepareForSessionMutation(liveSession: LiveSession) {
    liveSession.expectInternalSessionWrites();
  }

  private async createSdkSession(cwd: string, sessionManager: PiSessionManager) {
    const { result, tracker } = await GlobalMutationTracker.capture(() =>
      createAgentSession({
        cwd,
        agentDir: this.agentDir,
        authStorage: this.authStorage,
        modelRegistry: this.modelRegistry,
        sessionManager,
      })
    );

    return {
      session: result.session,
      globalMutationTracker: tracker,
    };
  }

  private async createOpenedSession(sessionFile: string, liveSession: LiveSession | undefined = undefined) {
    const sessionManager = SessionManager.open(sessionFile);
    const sessionHeader = sessionManager.getHeader?.();
    const sessionCwd = typeof sessionHeader?.cwd === "string" ? resolve(sessionHeader.cwd) : this.cwd;
    const { session, globalMutationTracker } = await this.createSdkSession(sessionCwd, sessionManager);
    const suppressNotifications = sessionManager.getEntries().length > 0;

    if (!liveSession) {
      return { session, sessionManager, globalMutationTracker, suppressNotifications };
    }

    const bindTracker = await this.bindSessionToLiveSession(session, liveSession, { suppressNotifications });
    return {
      session,
      sessionManager,
      globalMutationTracker: globalMutationTracker.merge(bindTracker),
    };
  }

  private async reloadLiveSessionFromDisk(liveSession: LiveSession, sessionFileOverride?: string) {
    const sessionFile = sessionFileOverride ?? (liveSession.session.sessionFile ? String(liveSession.session.sessionFile) : undefined);
    if (!sessionFile) {
      throw new Error("Only persisted sessions can be reloaded.");
    }

    const previousSessionId = String(liveSession.session.sessionId);
    const previousSessionFile = liveSession.session.sessionFile ? String(liveSession.session.sessionFile) : undefined;

    liveSession.releaseGlobalMutations();

    try {
      const { session, sessionManager, globalMutationTracker } = await this.createOpenedSession(sessionFile, liveSession);
      liveSession.replaceSession(session, sessionManager, globalMutationTracker);
      this.syncLiveSessionIdentity(liveSession, previousSessionId, previousSessionFile);
    } catch (error) {
      liveSession.restoreGlobalMutations();
      throw error;
    }
  }

  private async openSessionInternal(sessionFile: string, forceReload: boolean) {
    const existing = this.liveSessionsByPath.get(sessionFile);
    if (existing && !forceReload) {
      this.activateLiveSessionGlobals(existing);
      this.pruneInactiveSessions([String(existing.session.sessionId)]);
      return existing;
    }

    if (existing && forceReload) {
      this.unregisterLiveSession(existing);
      existing.dispose();
    }

    const { session, sessionManager, globalMutationTracker, suppressNotifications = false } = await this.createOpenedSession(sessionFile);

    const liveSession = await this.registerSession(session, sessionManager, globalMutationTracker, {
      suppressNotifications,
    });
    this.activateLiveSessionGlobals(liveSession);
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
    const liveSessionByPath = this.liveSessionsByPath.get(sessionInfo.path);
    const liveSession = liveSessionByPath
      && this.liveSessions.get(String(liveSessionByPath.session.sessionId)) === liveSessionByPath
      ? liveSessionByPath
      : undefined;

    if (liveSessionByPath && !liveSession) {
      this.liveSessionsByPath.delete(sessionInfo.path);
    }

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

  private async registerSession(
    session: AgentSession,
    sessionManager: PiSessionManager,
    globalMutationTracker: GlobalMutationTracker,
    options: {
      suppressNotifications: boolean;
    },
  ) {
    let liveSession!: LiveSession;
    liveSession = new LiveSession(
      session,
      sessionManager,
      (sessionFile) => this.reloadLiveSessionFromDisk(liveSession, sessionFile),
      globalMutationTracker,
    );
    this.liveSessions.set(String(session.sessionId), liveSession);
    this.cancelScheduledSessionDisposal(String(session.sessionId));

    if (session.sessionFile) {
      this.liveSessionsByPath.set(String(session.sessionFile), liveSession);
    }

    const bindTracker = await this.bindSessionToLiveSession(session, liveSession, options);
    liveSession.setGlobalMutationTracker(globalMutationTracker.merge(bindTracker));
    return liveSession;
  }

  private async bindSessionToLiveSession(
    session: AgentSession,
    liveSession: LiveSession,
    options: {
      suppressNotifications: boolean;
    },
  ) {
    const { tracker } = await GlobalMutationTracker.capture(() => bindSessionExtensions({
      session,
      uiContext: liveSession.createExtensionUiContext({ suppressNotifications: options.suppressNotifications }),
      commandContextActions: {
        waitForIdle: () => session.agent.waitForIdle(),
        newSession: async (options: any) => {
          liveSession.expectInternalSessionWrites();
          const previousSessionId = String(liveSession.session.sessionId);
          const previousSessionFile = liveSession.session.sessionFile ? String(liveSession.session.sessionFile) : undefined;
          const success = await session.newSession(options);
          if (success) {
            this.syncLiveSessionIdentity(liveSession, previousSessionId, previousSessionFile);
            liveSession.resetAfterSessionMutation();
          }
          return { cancelled: !success };
        },
        fork: async (entryId: string) => {
          liveSession.expectInternalSessionWrites();
          const previousSessionId = String(liveSession.session.sessionId);
          const previousSessionFile = liveSession.session.sessionFile ? String(liveSession.session.sessionFile) : undefined;
          const result = await session.fork(entryId);
          this.syncLiveSessionIdentity(liveSession, previousSessionId, previousSessionFile);
          liveSession.resetAfterSessionMutation();
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId: string, options: any) => {
          liveSession.expectInternalSessionWrites();
          const result = await session.navigateTree(targetId, options);
          liveSession.resetAfterSessionMutation();
          return { cancelled: result.cancelled };
        },
        switchSession: async (sessionPath: string) => {
          liveSession.expectInternalSessionWrites();
          const previousSessionId = String(liveSession.session.sessionId);
          const previousSessionFile = liveSession.session.sessionFile ? String(liveSession.session.sessionFile) : undefined;
          const success = await session.switchSession(sessionPath);
          if (success) {
            this.syncLiveSessionIdentity(liveSession, previousSessionId, previousSessionFile);
            liveSession.resetAfterSessionMutation();
          }
          return { cancelled: !success };
        },
        reload: async () => {
          liveSession.expectInternalSessionWrites();
          await this.reloadLiveSessionFromDisk(liveSession);
          liveSession.publishSnapshot();
        },
      },
      onError: (error: { error: string }) => {
        liveSession.publish({
          type: "error",
          message: error.error,
        });
      },
    }));

    return tracker;
  }

  private unregisterLiveSession(liveSession: LiveSession) {
    const sessionId = String(liveSession.session.sessionId);
    this.cancelScheduledSessionDisposal(sessionId);
    this.liveSessions.delete(sessionId);
    if (this.activeGlobalSessionId === sessionId) {
      this.activeGlobalSessionId = undefined;
    }
    if (liveSession.session.sessionFile) {
      this.liveSessionsByPath.delete(String(liveSession.session.sessionFile));
    }
  }

  private activateLiveSessionGlobals(liveSession: LiveSession) {
    const activeSessionId = String(liveSession.session.sessionId);

    for (const [sessionId, candidate] of this.liveSessions) {
      if (sessionId === activeSessionId) {
        continue;
      }
      candidate.releaseGlobalMutations();
    }

    liveSession.restoreGlobalMutations();
    this.activeGlobalSessionId = activeSessionId;
  }

  private syncLiveSessionIdentity(
    liveSession: LiveSession,
    previousSessionId: string,
    previousSessionFile: string | undefined,
  ) {
    this.cancelScheduledSessionDisposal(previousSessionId);
    this.liveSessions.delete(previousSessionId);
    if (previousSessionFile) {
      this.liveSessionsByPath.delete(previousSessionFile);
    }

    const nextSessionId = String(liveSession.session.sessionId);
    this.liveSessions.set(nextSessionId, liveSession);
    this.cancelScheduledSessionDisposal(nextSessionId);
    if (this.activeGlobalSessionId === previousSessionId) {
      this.activeGlobalSessionId = nextSessionId;
    }
    if (liveSession.session.sessionFile) {
      this.liveSessionsByPath.set(String(liveSession.session.sessionFile), liveSession);
    }
  }

  private pruneInactiveSessions(keepSessionIds: Iterable<string>) {
    const keep = new Set([...keepSessionIds].map(String));

    for (const [sessionId, liveSession] of this.liveSessions) {
      if (keep.has(sessionId) || !this.isInactiveLiveSession(liveSession)) {
        this.cancelScheduledSessionDisposal(sessionId);
        continue;
      }

      this.scheduleSessionDisposal(sessionId);
    }
  }

  private scheduleSessionDisposal(sessionId: string) {
    const liveSession = this.liveSessions.get(sessionId);
    if (!liveSession || !this.isInactiveLiveSession(liveSession)) {
      this.cancelScheduledSessionDisposal(sessionId);
      return;
    }
    if (this.scheduledSessionDisposals.has(sessionId)) {
      return;
    }

    const timeoutId = setTimeout(() => {
      this.scheduledSessionDisposals.delete(sessionId);
      const currentLiveSession = this.liveSessions.get(sessionId);
      if (!currentLiveSession || !this.isInactiveLiveSession(currentLiveSession)) {
        return;
      }

      this.unregisterLiveSession(currentLiveSession);
      currentLiveSession.dispose();
    }, LIVE_SESSION_DISPOSE_DELAY_MS);

    this.scheduledSessionDisposals.set(sessionId, timeoutId);
  }

  private cancelScheduledSessionDisposal(sessionId: string) {
    const timeoutId = this.scheduledSessionDisposals.get(sessionId);
    if (!timeoutId) {
      return;
    }

    clearTimeout(timeoutId);
    this.scheduledSessionDisposals.delete(sessionId);
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

      const now = Date.now();
      if (liveSession.isInternalChangeExpected(now) || now - liveSession.lastInternalUpdateAt <= INTERNAL_CHANGE_WINDOW_MS) {
        return;
      }

      liveSession.markExternalChange({ reloadImmediately: liveSession.subscribers.size > 0 });
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
