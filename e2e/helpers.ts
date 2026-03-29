import { expect, type Locator, type Page } from "@playwright/test";

export const PRIMARY_SESSION_TITLE = "Playwright harness smoke fixture";
export const SECONDARY_SESSION_TITLE = "Secondary session switch target";
export const ARCHIVE_SESSION_TITLE = "Archive session for sidebar filtering";
export const EDIT_FORK_PROMPT = "Follow-up prompt for edit and fork flows";

export function activeConversation(page: Page): Locator {
  return page.getByLabel("Active conversation");
}

export function composer(page: Page): Locator {
  return page.locator(".pp-composer-input");
}

export function sessionItems(page: Page): Locator {
  return page.locator(".pp-session-item");
}

export function sessionItem(page: Page, title: string, messageCount?: number): Locator {
  let item = page
    .locator(".pp-session-item")
    .filter({ has: page.locator(".pp-session-title", { hasText: title }) });

  if (messageCount !== undefined) {
    item = item.filter({ has: page.locator(".pp-session-badge", { hasText: String(messageCount) }) });
  }

  return item.first();
}

export async function openApp(
  page: Page,
  options: {
    expectedTitle?: string;
    expectedMessageCount?: number;
    expectedSessionCount?: number;
  } = {},
) {
  const expectedTitle = options.expectedTitle ?? PRIMARY_SESSION_TITLE;
  const expectedMessageCount = options.expectedMessageCount ?? 7;

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Pi Web")).toBeVisible();

  if (options.expectedSessionCount !== undefined) {
    await expect(sessionItems(page)).toHaveCount(options.expectedSessionCount);
  } else {
    await expect(sessionItems(page).first()).toBeVisible();
  }

  const heading = activeConversation(page).getByRole("heading", { name: expectedTitle });
  if (!(await heading.isVisible().catch(() => false))) {
    await sessionItem(page, expectedTitle, expectedMessageCount).click();
  }

  await expect(heading).toBeVisible();
}

export async function closeMenu(page: Page) {
  const overlay = page.locator(".pp-menu-overlay");
  if (await overlay.isVisible()) {
    await overlay.click({ position: { x: 5, y: 5 } });
    await expect(overlay).toBeHidden();
  }
}

export async function chooseMenuItem(page: Page, label: string) {
  const menu = page.locator(".pp-menu");
  if (!(await menu.isVisible())) {
    await page.getByRole("button", { name: "Menu" }).click();
  }

  await expect(menu).toBeVisible();
  await page.locator(".pp-menu-item").filter({ hasText: label }).first().click();
  await closeMenu(page);
}

export function toolCard(page: Page, toolName: string): Locator {
  const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page
    .locator(".pp-tool-card")
    .filter({ has: page.locator(".pp-tool-name", { hasText: new RegExp(`^${escapedToolName}$`) }) })
    .first();
}

export function toolMessageRow(page: Page): Locator {
  return page
    .locator(".pp-message-row-assistant")
    .filter({ hasText: "This response includes grouped tool activity for the E2E harness." })
    .first();
}
