import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openApp, PRIMARY_SESSION_TITLE } from "./helpers";

const e2eDir = dirname(fileURLToPath(import.meta.url));
const runtimeDir = resolve(e2eDir, ".runtime");
const expectedAgentDir = resolve(runtimeDir, "agent");
const expectedWorkspaceDir = resolve(runtimeDir, "workspace");

test("boots the real app against repo-local deterministic fixtures", async ({ page, request }) => {
  const healthResponse = await request.get("/api/health");
  expect(healthResponse.ok()).toBeTruthy();
  await expect(healthResponse).toBeOK();
  expect(await healthResponse.json()).toMatchObject({
    ok: true,
    agentDir: expectedAgentDir,
    cwd: expectedWorkspaceDir,
  });

  await openApp(page, { expectedTitle: PRIMARY_SESSION_TITLE });
  await expect(page.getByLabel("Active conversation")).toContainText("msgs");
  await expect(page.getByLabel("Active conversation")).toContainText("No model");
  await expect(page.getByText("Fixture session ready for Playwright.")).toBeVisible();
  await expect(page.getByPlaceholder("Search sessions…")).toHaveValue("");
});
