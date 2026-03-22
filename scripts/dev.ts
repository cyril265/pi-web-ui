import { fileURLToPath } from "node:url";

const host = process.env.HOST ?? "127.0.0.1";
const serverPortStart = Number(process.env.PORT ?? 3001);
const clientPortStart = Number(process.env.CLIENT_PORT ?? 5173);
const rootDir = fileURLToPath(new URL("..", import.meta.url));

const serverPort = await findFreePort(serverPortStart, new Set<number>(), host);
const clientPort = await findFreePort(clientPortStart, new Set<number>([serverPort]), host);

console.log(`[dev] host: ${host}`);
console.log(`[dev] server port: ${serverPort}`);
console.log(`[dev] client url: http://${host}:${clientPort}`);

const children = [
  spawnProcess("server", ["run", "--filter", "@pi-web-app/server", "dev"], {
    ...process.env,
    HOST: host,
    PORT: String(serverPort),
  }),
  spawnProcess("client", ["run", "--filter", "@pi-web-app/client", "dev"], {
    ...process.env,
    HOST: host,
    API_PORT: String(serverPort),
    CLIENT_PORT: String(clientPort),
  }),
];

let shuttingDown = false;
let exitHandled = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(0));
}

for (const child of children) {
  child.process.exited.then((code) => {
    if (shuttingDown) {
      return;
    }

    console.log(`[dev] ${child.name} exited (${code})`);
    shutdown(code);
  });
}

function spawnProcess(name: string, args: string[], env: NodeJS.ProcessEnv) {
  return {
    name,
    process: Bun.spawn([process.execPath, ...args], {
      cwd: rootDir,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }),
  };
}

function shutdown(exitCode: number) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (child.process.exitCode === null) {
      child.process.kill("SIGTERM");
    }
  }

  const timeout = setTimeout(() => {
    for (const child of children) {
      if (child.process.exitCode === null) {
        child.process.kill("SIGKILL");
      }
    }

    finish(exitCode);
  }, 1_000);

  timeout.unref?.();

  Promise.all(children.map((child) => child.process.exited.catch(() => exitCode))).then(() => {
    clearTimeout(timeout);
    finish(exitCode);
  });
}

function finish(exitCode: number) {
  if (exitHandled) {
    return;
  }

  exitHandled = true;
  process.exit(exitCode);
}

async function findFreePort(start: number, reserved = new Set<number>(), host = "127.0.0.1") {
  let port = start;

  while (reserved.has(port) || !(await isPortFree(port, host))) {
    port++;
  }

  return port;
}

async function isPortFree(port: number, host = "127.0.0.1") {
  try {
    const listener = Bun.listen({
      hostname: host,
      port,
      socket: {
        open() {},
        data() {},
        drain() {},
        close() {},
        error() {},
      },
    });

    listener.stop(true);
    return true;
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: string }).code === "EADDRINUSE"
    ) {
      return false;
    }

    throw err;
  }
}
