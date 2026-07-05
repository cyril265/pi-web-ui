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
  // The "Pi Web" wordmark is hidden on mobile widths once a session title
  // shows, so gate on the always-present header instead.
  await expect(page.locator(".pp-header")).toBeVisible();

  if (options.expectedSessionCount !== undefined) {
    await expect(sessionItems(page)).toHaveCount(options.expectedSessionCount);
  } else {
    await expect(sessionItems(page).first()).toBeVisible();
  }

  if (!(await isActiveSession(page, expectedTitle))) {
    // On mobile widths the sidebar is a closed overlay, so open it before
    // picking the session; selecting one auto-closes the overlay again.
    const expandButton = page.getByRole("button", { name: "Expand sidebar" });
    if (await expandButton.isVisible().catch(() => false)) {
      await expandButton.click();
    }
    await sessionItem(page, expectedTitle, expectedMessageCount).click();
  }

  await expectActiveSession(page, expectedTitle);
}

// The active session title lives in the sub-header on desktop and moves into
// the top bar on phones, so the readiness check has to look at both spots.
function activeSessionHeading(page: Page): Locator {
  return activeConversation(page).getByRole("heading");
}

async function isActiveSession(page: Page, title: string): Promise<boolean> {
  const headerTitle = page.locator(".pp-header-session-title");
  if (await headerTitle.isVisible().catch(() => false)) {
    return (await headerTitle.textContent().catch(() => null))?.trim() === title;
  }
  return activeSessionHeading(page).filter({ hasText: title }).isVisible().catch(() => false);
}

export async function expectActiveSession(page: Page, title: string) {
  const headerTitle = page.locator(".pp-header-session-title");
  if (await headerTitle.isVisible().catch(() => false)) {
    await expect(headerTitle).toHaveText(title);
    return;
  }
  await expect(activeConversation(page).getByRole("heading", { name: title })).toBeVisible();
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
