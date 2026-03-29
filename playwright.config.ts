import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));
const runtimeDir = resolve(rootDir, "e2e/.runtime");
const agentDir = resolve(runtimeDir, "agent");
const workspaceDir = resolve(runtimeDir, "workspace");
const port = "3310";
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "bun run e2e:serve",
    cwd: rootDir,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: port,
      PI_AGENT_DIR: agentDir,
      PI_WORKSPACE_DIR: workspaceDir,
    },
  },
});
