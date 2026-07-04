import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { ApiDirectoryListing, ApiImageInput, SessionCatalogEvent, SessionEvent, ThinkingLevel } from "@pi-web-app/shared";
import { SessionRegistry } from "./pi/session-registry.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3001);
const currentDir = dirname(fileURLToPath(import.meta.url));
const cwd = resolve(process.env.PI_WORKSPACE_DIR ?? resolve(currentDir, "../.."));
const clientDist = resolve(currentDir, "../../client/dist");
const clipboardImagePathPattern = /(?:^|\/)pi-clipboard-[\w-]+\.(png|jpe?g|gif|webp)$/i;
const clipboardImageMimeTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const sessionRegistry = new SessionRegistry(cwd);
const app = Fastify({ logger: true });

const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

async function listDirectories(requestedPath?: string): Promise<ApiDirectoryListing> {
  const directoryPath = requestedPath?.trim() ? resolve(cwd, requestedPath.trim()) : cwd;
  const directoryStats = await stat(directoryPath).catch(() => undefined);
  if (!directoryStats?.isDirectory()) {
    throw new Error(`Directory not found: ${directoryPath}`);
  }

  const entries = await readdir(directoryPath, { withFileTypes: true }).catch((error: unknown) => {
    throw new Error(`Failed to read directory: ${getErrorMessage(error)}`);
  });
  const parentPath = dirname(directoryPath);

  const directories = await Promise.all(entries.map(async (entry) => {
    const entryPath = resolve(directoryPath, entry.name);
    if (entry.isDirectory()) {
      return {
        name: entry.name,
        path: entryPath,
      };
    }

    if (!entry.isSymbolicLink()) {
      return undefined;
    }

    const entryStats = await stat(entryPath).catch(() => undefined);
    if (!entryStats?.isDirectory()) {
      return undefined;
    }

    return {
      name: entry.name,
      path: entryPath,
    };
  }));

  return {
    path: directoryPath,
    parentPath: parentPath === directoryPath ? undefined : parentPath,
    directories: directories
      .filter((entry): entry is ApiDirectoryListing["directories"][number] => Boolean(entry))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

app.get("/api/health", async () => ({
  ok: true,
  cwd,
  agentDir: sessionRegistry.agentDir,
}));

app.get("/api/models", async () => ({
  models: await sessionRegistry.getAvailableModels(),
}));

app.post<{ Body: { path: string } }>("/api/clipboard-image", async (request, reply) => {
  const imagePath = request.body.path.trim();
  if (!clipboardImagePathPattern.test(imagePath)) {
    return reply.code(400).send({ message: "Unsupported clipboard image path" });
  }

  const extension = imagePath.split(".").at(-1)?.toLowerCase();
  const mimeType = extension ? clipboardImageMimeTypes[extension] : undefined;
  if (!mimeType) {
    return reply.code(400).send({ message: "Unsupported clipboard image type" });
  }

  try {
    const data = (await readFile(imagePath)).toString("base64");
    return {
      attachment: {
        fileName: basename(imagePath),
        mimeType,
        data,
      },
    };
  } catch {
    return reply.code(404).send({ message: "Clipboard image not found" });
  }
});

app.get<{ Querystring: { scope?: "current" | "all" } }>("/api/sessions", async (request) => ({
  sessions: await sessionRegistry.listSessions(request.query.scope === "all" ? "all" : "current"),
}));

app.get<{ Querystring: { path?: string } }>("/api/directories", async (request, reply) => {
  try {
    return await listDirectories(request.query.path);
  } catch (error) {
    return reply.code(400).type("text/plain").send(getErrorMessage(error));
  }
});

app.post<{ Body: { path?: string } }>("/api/sessions", async (request, reply) => {
  try {
    const liveSession = await sessionRegistry.createSession(request.body?.path);
    return {
      snapshot: liveSession.getSnapshot(),
    };
  } catch (error) {
    return reply.code(400).type("text/plain").send(getErrorMessage(error));
  }
});

app.post<{ Body: { path: string } }>("/api/sessions/open", async (request) => {
  const liveSession = await sessionRegistry.openSession(request.body.path);
  return {
    snapshot: liveSession.getSnapshot(),
  };
});

app.get("/api/sessions/events", async (request, reply) => {
  reply.hijack();
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.flushHeaders();

  const sendEvent = (event: SessionCatalogEvent) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const unsubscribe = sessionRegistry.subscribeToSessionListChanges(() => {
    sendEvent({ type: "sessions_changed" });
  });
  const keepAlive = setInterval(() => {
    reply.raw.write(": keepalive\n\n");
  }, 15_000);

  request.raw.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
    if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
  });
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId", async (request, reply) => {
  try {
    const liveSession = sessionRegistry.activateSession(request.params.sessionId);
    return {
      snapshot: liveSession.getSnapshot(),
    };
  } catch {
    return reply.code(404).send({ message: "Session not found" });
  }
});

app.post<{ Params: { sessionId: string }; Body: { columns: number } }>("/api/sessions/:sessionId/layout", async (request, reply) => {
  const liveSession = sessionRegistry.getLiveSession(request.params.sessionId);
  if (!liveSession) {
    return reply.code(404).send({ message: "Session not found" });
  }

  liveSession.setLayoutColumns(request.body?.columns);
  return { ok: true };
});

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/commands", async (request) => ({
  commands: await sessionRegistry.getSlashCommands(request.params.sessionId),
}));

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/events", async (request, reply) => {
  const liveSession = sessionRegistry.getLiveSession(request.params.sessionId);
  if (!liveSession) {
    return reply.code(404).send({ message: "Session not found" });
  }

  reply.hijack();
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.flushHeaders();

  const sendEvent = (event: SessionEvent) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const unsubscribe = liveSession.subscribe(sendEvent);
  const keepAlive = setInterval(() => {
    reply.raw.write(": keepalive\n\n");
  }, 15_000);

  request.raw.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
    if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
    sessionRegistry.disposeIfInactive(request.params.sessionId);
  });
});

app.post<{ Params: { sessionId: string }; Body: { message: string; images?: ApiImageInput[] } }>(
  "/api/sessions/:sessionId/prompt",
  async (request) => {
    await sessionRegistry.prompt(request.params.sessionId, request.body.message, request.body.images ?? []);
    return { ok: true };
  },
);

app.post<{ Params: { sessionId: string }; Body: { message: string } }>("/api/sessions/:sessionId/steer", async (request) => {
  await sessionRegistry.steer(request.params.sessionId, request.body.message);
  return { ok: true };
});

app.post<{ Params: { sessionId: string }; Body: { message: string } }>(
  "/api/sessions/:sessionId/follow-up",
  async (request) => {
    await sessionRegistry.followUp(request.params.sessionId, request.body.message);
    return { ok: true };
  },
);

app.post<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/abort", async (request) => {
  await sessionRegistry.abort(request.params.sessionId);
  return { ok: true };
});

app.post<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/model/cycle", async (request) => {
  await sessionRegistry.cycleModel(request.params.sessionId);
  return { ok: true };
});

app.post<{ Params: { sessionId: string }; Body: { provider: string; modelId: string } }>(
  "/api/sessions/:sessionId/model",
  async (request) => {
    await sessionRegistry.setModel(request.params.sessionId, request.body.provider, request.body.modelId);
    return { ok: true };
  },
);

app.post<{ Params: { sessionId: string }; Body: { thinkingLevel: ThinkingLevel } }>(
  "/api/sessions/:sessionId/thinking-level",
  async (request) => {
    sessionRegistry.setThinkingLevel(request.params.sessionId, request.body.thinkingLevel);
    return { ok: true };
  },
);

app.post<{ Params: { sessionId: string }; Body: { name: string } }>("/api/sessions/:sessionId/rename", async (request) => {
  const liveSession = sessionRegistry.renameSession(request.params.sessionId, request.body.name);
  return {
    snapshot: liveSession.getSnapshot(),
  };
});

app.post<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/reopen", async (request) => {
  const liveSession = await sessionRegistry.reopenSession(request.params.sessionId);
  return {
    snapshot: liveSession.getSnapshot(),
  };
});

app.post<{ Params: { sessionId: string }; Body: { instructions?: string } }>(
  "/api/sessions/:sessionId/compact",
  async (request) => {
    const liveSession = await sessionRegistry.compactSession(request.params.sessionId, request.body.instructions);
    return {
      snapshot: liveSession.getSnapshot(),
    };
  },
);

app.post<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/reload", async (request) => {
  const liveSession = await sessionRegistry.reloadSession(request.params.sessionId);
  return {
    snapshot: liveSession.getSnapshot(),
  };
});

app.post<{ Params: { sessionId: string }; Body: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean } }>(
  "/api/sessions/:sessionId/ui-response",
  async (request) => {
    sessionRegistry.respondToUiRequest(request.params.sessionId, {
      id: request.body.id,
      value: request.body.value,
      confirmed: request.body.confirmed,
      cancelled: request.body.cancelled,
    });
    return { ok: true };
  },
);

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/fork-messages", async (request) => ({
  messages: sessionRegistry.getForkMessages(request.params.sessionId),
}));

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/tree-messages", async (request) => ({
  messages: sessionRegistry.getTreeMessages(request.params.sessionId),
}));

app.post<{ Params: { sessionId: string }; Body: { entryId: string } }>("/api/sessions/:sessionId/fork", async (request) => {
  const result = await sessionRegistry.fork(request.params.sessionId, request.body.entryId);
  return {
    cancelled: result.cancelled,
    selectedText: result.selectedText,
    snapshot: result.liveSession.getSnapshot(),
  };
});

app.post<{ Params: { sessionId: string }; Body: { entryId: string } }>("/api/sessions/:sessionId/tree", async (request) => {
  const result = await sessionRegistry.navigateTree(request.params.sessionId, request.body.entryId);
  return {
    cancelled: result.cancelled,
    editorText: result.editorText,
    snapshot: result.liveSession.getSnapshot(),
  };
});

if (existsSync(clientDist)) {
  await app.register(fastifyStatic, {
    root: clientDist,
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ message: "Not found" });
    }

    return reply.sendFile("index.html");
  });
}

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  reply.code(500).send({
    message: error instanceof Error ? error.message : String(error),
  });
});

await app.listen({ host, port });
app.log.info(`Pi web server listening on http://${host}:${port}`);
