import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
const execFileAsync = promisify(execFile);

type ExecFileError = Error & {
  code?: string | number;
  stderr?: string;
};

const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const isExecFileError = (error: unknown): error is ExecFileError => error instanceof Error;

const isDirectoryPickerCancelled = (error: unknown) => {
  if (!isExecFileError(error)) {
    return false;
  }

  const message = `${error.message}\n${error.stderr ?? ""}`.toLowerCase();
  return error.code === 1 || error.code === "1" || message.includes("user canceled") || message.includes("canceled");
};

const escapeAppleScriptString = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
const escapePowerShellString = (value: string) => value.replaceAll("'", "''");

async function selectDirectory(initialPath?: string) {
  const defaultPath = initialPath?.trim() ? resolve(cwd, initialPath.trim()) : cwd;

  if (process.platform === "darwin") {
    const script = `
set defaultLocation to POSIX file "/" as alias
try
  set defaultLocation to POSIX file "${escapeAppleScriptString(defaultPath)}" as alias
end try
set chosenFolder to choose folder with prompt "Select a project directory" default location defaultLocation
POSIX path of chosenFolder
`;

    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script]);
      return stdout.trim() || undefined;
    } catch (error) {
      if (isDirectoryPickerCancelled(error)) {
        return undefined;
      }
      throw new Error(`Failed to open the macOS directory picker: ${getErrorMessage(error)}`);
    }
  }

  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Select a project directory'",
      `$dialog.SelectedPath = '${escapePowerShellString(defaultPath)}'`,
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
    ].join("; ");

    try {
      const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-STA", "-Command", script]);
      return stdout.trim() || undefined;
    } catch (error) {
      if (isDirectoryPickerCancelled(error)) {
        return undefined;
      }
      throw new Error(`Failed to open the Windows directory picker: ${getErrorMessage(error)}`);
    }
  }

  try {
    const { stdout } = await execFileAsync("zenity", [
      "--file-selection",
      "--directory",
      "--title=Select a project directory",
      `--filename=${defaultPath.endsWith("/") ? defaultPath : `${defaultPath}/`}`,
    ]);
    return stdout.trim() || undefined;
  } catch (error) {
    if (isDirectoryPickerCancelled(error)) {
      return undefined;
    }
    if (isExecFileError(error) && error.code !== "ENOENT") {
      throw new Error(`Failed to open the Linux directory picker: ${getErrorMessage(error)}`);
    }
  }

  try {
    const { stdout } = await execFileAsync("kdialog", ["--getexistingdirectory", defaultPath, "--title", "Select a project directory"]);
    return stdout.trim() || undefined;
  } catch (error) {
    if (isDirectoryPickerCancelled(error)) {
      return undefined;
    }
    if (isExecFileError(error) && error.code === "ENOENT") {
      throw new Error("No supported directory picker found. Paste a path manually.");
    }
    throw new Error(`Failed to open the Linux directory picker: ${getErrorMessage(error)}`);
  }
}

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

app.post<{ Body: { initialPath?: string } }>("/api/directories/select", async (request, reply) => {
  try {
    const path = await selectDirectory(request.body?.initialPath);
    return {
      cancelled: !path,
      path,
    };
  } catch (error) {
    return reply.code(500).type("text/plain").send(getErrorMessage(error));
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
