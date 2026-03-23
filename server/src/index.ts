import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { ApiImageInput, SessionEvent, ThinkingLevel } from "@pi-web-app/shared";
import { SessionRegistry } from "./pi/session-registry.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3001);
const currentDir = dirname(fileURLToPath(import.meta.url));
const cwd = resolve(process.env.PI_WORKSPACE_DIR ?? resolve(currentDir, "../.."));
const clientDist = resolve(currentDir, "../../client/dist");

const sessionRegistry = new SessionRegistry(cwd);
const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true,
  credentials: true,
});

app.get("/api/health", async () => ({
  ok: true,
  cwd,
  agentDir: sessionRegistry.agentDir,
}));

app.get("/api/models", async () => ({
  models: await sessionRegistry.getAvailableModels(),
}));

app.get<{ Querystring: { scope?: "current" | "all" } }>("/api/sessions", async (request) => ({
  sessions: await sessionRegistry.listSessions(request.query.scope === "all" ? "all" : "current"),
}));

app.post("/api/sessions", async () => {
  const liveSession = await sessionRegistry.createSession();
  return {
    snapshot: liveSession.getSnapshot(),
  };
});

app.post<{ Body: { path: string } }>("/api/sessions/open", async (request) => {
  const liveSession = await sessionRegistry.openSession(request.body.path);
  return {
    snapshot: liveSession.getSnapshot(),
  };
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

app.get<{ Params: { sessionId: string } }>("/api/sessions/:sessionId/commands", async (request) => ({
  commands: sessionRegistry.getSlashCommands(request.params.sessionId),
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
