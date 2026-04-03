import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIVE_SESSION_TITLE, composer, PRIMARY_SESSION_TITLE, SECONDARY_SESSION_TITLE, sessionItem, sessionItems } from "./helpers";

const e2eDir = dirname(fileURLToPath(import.meta.url));
const secondarySessionFile = resolve(e2eDir, ".runtime/agent/sessions/fixture-secondary-session.jsonl");

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

test.describe("session resilience", () => {
  test("clicking a session keeps sidebar ordering stable", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(sessionItems(page).first()).toBeVisible();

    const getSessionTitles = () => page.locator(".pp-session-title").evaluateAll((elements) =>
      elements.map((element) => element.textContent?.trim() ?? "")
    );

    const before = await getSessionTitles();
    await sessionItem(page, SECONDARY_SESSION_TITLE, 2).click();
    await expect(page.getByText("Secondary session opened from the sidebar.")).toBeVisible();
    await expect.poll(getSessionTitles).toEqual(before);
  });

  test("keeps a live session available briefly after the SSE client disconnects", async ({ request, baseURL }) => {
    expect(baseURL).toBeTruthy();

    const openResponse = await request.post("/api/sessions/open", {
      data: { path: secondarySessionFile },
    });
    await expect(openResponse).toBeOK();

    const { snapshot } = await openResponse.json() as {
      snapshot: {
        sessionId: string;
      };
    };

    const abortController = new AbortController();
    const eventsResponse = await fetch(`${baseURL}/api/sessions/${snapshot.sessionId}/events`, {
      signal: abortController.signal,
    });
    expect(eventsResponse.ok).toBeTruthy();
    expect(eventsResponse.body).toBeTruthy();

    const eventsReader = eventsResponse.body!.getReader();
    await eventsReader.read();
    abortController.abort();
    await eventsReader.cancel().catch(() => undefined);
    await delay(200);

    const snapshotResponse = await request.get(`/api/sessions/${snapshot.sessionId}`);
    await expect(snapshotResponse).toBeOK();

    const sessionsResponse = await request.get("/api/sessions?scope=all");
    await expect(sessionsResponse).toBeOK();
    const { sessions } = await sessionsResponse.json() as {
      sessions: Array<{
        id: string;
        live: boolean;
      }>;
    };

    expect(sessions.find((session) => session.id === snapshot.sessionId)?.live).toBe(true);
  });

  test("disables the composer while switching sessions and keeps messages visible after the switch", async ({ page }) => {
    await page.route("**/api/sessions/open", async (route) => {
      await delay(500);
      await route.continue();
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(sessionItems(page).first()).toBeVisible();
    await expect(composer(page)).toBeEnabled();

    await sessionItem(page, ARCHIVE_SESSION_TITLE, 2).click();
    await expect(composer(page)).toBeDisabled();
    await expect(page.locator(".pp-session-item.loading")).toHaveCount(1);
    await expect(page.getByText("Archive fixture available for search coverage.")).toBeVisible();
    await expect(composer(page)).toBeEnabled();

    await sessionItem(page, PRIMARY_SESSION_TITLE, 7).click();
    await expect(page.getByText("Fixture session ready for Playwright.")).toBeVisible();
    await expect(composer(page)).toBeEnabled();
  });
});
