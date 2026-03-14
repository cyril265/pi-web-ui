import net from "node:net";
import { spawn } from "node:child_process";

const host = process.env.HOST ?? "127.0.0.1";
const serverPortStart = Number(process.env.PORT ?? 3001);
const clientPortStart = Number(process.env.CLIENT_PORT ?? 5173);

const serverPort = await findAvailablePort(serverPortStart);
const clientPort = await findAvailablePort(clientPortStart, new Set([serverPort]));

console.log(`[dev] host: ${host}`);
console.log(`[dev] server port: ${serverPort}`);
console.log(`[dev] client port: http://${host}:${clientPort}`);

const children = [
  spawnProcess("server", "npm", ["run", "dev", "--workspace", "@pi-web-app/server"], {
    ...process.env,
    PORT: String(serverPort),
  }),
  spawnProcess("client", "npm", ["run", "dev", "--workspace", "@pi-web-app/client"], {
    ...process.env,
    API_PORT: String(serverPort),
    CLIENT_PORT: String(clientPort),
  }),
];

let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;

    const exitCode = code ?? (signal ? 1 : 0);
    console.log(`[dev] ${child.name} exited (${signal ?? exitCode})`);
    shutdown(exitCode);
  });
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }
    process.exit(exitCode);
  }, 1_000).unref();
}

function spawnProcess(name, command, args, env) {
  const child = spawn(command, args, {
    env,
    stdio: "inherit",
  });

  child.name = name;
  return child;
}

async function findAvailablePort(startPort, reservedPorts = new Set()) {
  let port = startPort;

  while (reservedPorts.has(port) || !(await isPortAvailable(port))) {
    port += 1;
  }

  return port;
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen({ port });
  });
}
