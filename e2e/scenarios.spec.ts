import { expect, test } from "@playwright/test";
import {
  activeConversation,
  ARCHIVE_SESSION_TITLE,
  chooseMenuItem,
  composer,
  EDIT_FORK_PROMPT,
  openApp,
  PRIMARY_SESSION_TITLE,
  SECONDARY_SESSION_TITLE,
  sessionItem,
  sessionItems,
  toolCard,
  toolMessageRow,
} from "./helpers";

test.describe.serial("broad real-interaction scenarios", () => {
  test("desktop boot covers session list, sidebar docking, display persistence, markdown, diff, and tool activity", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: "http://127.0.0.1:3310",
    });

    await openApp(page, { expectedSessionCount: 3 });

    const shell = page.locator(".pp-shell");
    const body = page.locator(".pp-body");
    const html = page.locator("html");

    await expect(body).toHaveClass(/sidebar-docked/);
    await expect(page.locator(".pp-sidebar.desktop")).toHaveAttribute("aria-hidden", "false");

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(body).toHaveClass(/sidebar-closed/);
    await expect(page.locator(".pp-sidebar.desktop")).toHaveAttribute("aria-hidden", "true");
    await expect(page.getByRole("button", { name: "Show session list" })).toBeVisible();
    await page.getByRole("button", { name: "Show session list" }).click();
    await expect(body).toHaveClass(/sidebar-open/);

    const defaultMessageFontSize = await shell.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).getPropertyValue("--pp-message-font-size"))
    );
    expect(defaultMessageFontSize).toBeCloseTo(0.875, 3);

    await chooseMenuItem(page, "Dense / CLI");
    await expect(html).toHaveAttribute("data-display-mode", "dense");
    await expect(shell).toHaveAttribute("data-display-mode", "dense");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("display-mode")))
      .toBe("dense");

    const denseMessageFontSize = await shell.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).getPropertyValue("--pp-message-font-size"))
    );
    expect(denseMessageFontSize).toBeCloseTo(0.8125, 3);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(activeConversation(page).getByRole("heading", { name: PRIMARY_SESSION_TITLE })).toBeVisible();
    await expect(html).toHaveAttribute("data-display-mode", "dense");
    await expect(shell).toHaveAttribute("data-display-mode", "dense");

    const thinkingLevelButton = page.getByRole("button", { name: "Thinking level: Off" });
    await expect(thinkingLevelButton).toBeVisible();
    await thinkingLevelButton.click();
    await expect(page.getByRole("button", { name: "High Current" })).toHaveCount(0);
    await page.getByRole("button", { name: "High" }).click();
    await expect(page.getByRole("button", { name: "Thinking level: High" })).toBeVisible();

    const primaryAssistantMessage = page
      .locator(".pp-message-row-assistant")
      .filter({ hasText: "Fixture session ready for Playwright." })
      .first();

    const thinkingBlock = page.locator(".pp-thinking").filter({ hasText: "Inspecting the fixture session." }).first();
    await expect(thinkingBlock).toBeVisible();
    await expect(thinkingBlock.locator(".pp-thinking-label")).toHaveText("Thinking");
    await expect(thinkingBlock.locator(".pp-thinking-content")).toContainText("Preparing markdown, diff, and tool activity examples for the UI.");

    const typeScriptBlock = primaryAssistantMessage
      .locator(".pp-code-block")
      .filter({ has: page.locator(".pp-code-language", { hasText: "TypeScript" }) })
      .first();

    await expect(typeScriptBlock).toContainText("export function greet");
    await expect(typeScriptBlock.locator(".pp-code-language")).toHaveText("TypeScript");
    await expect(typeScriptBlock.locator("code .hljs-keyword").first()).toHaveText("export");

    const copyButton = typeScriptBlock.locator(".pp-copy-btn");
    await copyButton.click();
    await expect(copyButton).toHaveText("Copied!");
    await expect
      .poll(async () => {
        try {
          return await page.evaluate(() => navigator.clipboard.readText());
        } catch {
          return "";
        }
      })
      .toContain("export function greet");

    const markdownTable = primaryAssistantMessage.locator(".pp-markdown table").first();
    await expect(markdownTable).toBeVisible();
    await expect(markdownTable).toContainText("Area");
    await expect(markdownTable).toContainText("Markdown");
    await expect(markdownTable).toContainText("Rendered");

    const diffBlock = primaryAssistantMessage.locator(".pp-code-block-diff").first();
    await expect(diffBlock.locator(".pp-code-language")).toHaveText("Diff");
    await expect(diffBlock.locator(".pp-diff-line-remove")).toContainText('-const mode = "default";');
    await expect(diffBlock.locator(".pp-diff-line-add")).toHaveCount(2);
    await expect(diffBlock).toContainText('+const mode = "dense";');
    await expect(diffBlock).toContainText("+console.log(mode);");
    await expect(diffBlock.locator(".pp-diff-line-hunk")).toContainText("@@ -1,2 +1,3 @@");

    const successfulTool = toolCard(page, "bash");
    await expect(successfulTool).toBeVisible();
    await expect(successfulTool.locator(".pp-tool-status.done")).toHaveText("Done");
    await expect(successfulTool.locator(".pp-tool-preview")).toContainText("app.css");

    const failedTool = toolCard(page, "read_file");
    await expect(failedTool).toBeVisible();
    await expect(failedTool).toHaveAttribute("open", "");
    await expect(failedTool.locator(".pp-tool-status.error")).toHaveText("Failed");
    await expect(failedTool.locator(".pp-tool-preview")).toContainText("permission denied");
    await expect(failedTool.locator(".pp-tool-section-label").filter({ hasText: "Error" })).toBeVisible();

    const successfulReadTool = toolCard(page, "read");
    await expect(successfulReadTool).toBeVisible();
    await expect(successfulReadTool.locator(".pp-tool-status.done")).toHaveText("Done");
    await expect(successfulReadTool.locator(".pp-tool-preview")).toContainText('export type SessionStatus = "idle" | "streaming" | "error";');
    await expect(successfulReadTool.locator(".pp-tool-section-label").filter({ hasText: "Result" })).toBeVisible();

    await chooseMenuItem(page, "Default");
    await expect(html).toHaveAttribute("data-display-mode", "default");
  });

  test.describe("mobile sidebar overlay", () => {
    test.use({ viewport: { width: 430, height: 932 } });

    test("switches sessions through the overlay sidebar without losing composer state", async ({ page }) => {
      await openApp(page, { expectedSessionCount: 3 });

      const body = page.locator(".pp-body");
      const mobileSidebar = page.locator(".pp-sidebar.mobile");
      const searchInput = page.getByPlaceholder("Search sessions…");

      await expect(body).toHaveClass(/sidebar-overlay/);
      await expect(body).toHaveClass(/sidebar-closed/);
      await expect(mobileSidebar).toHaveAttribute("aria-hidden", "true");

      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await expect(body).toHaveClass(/sidebar-open/);
      await expect(page.getByRole("button", { name: "Close sidebar" })).toBeVisible();
      await expect(mobileSidebar).toHaveAttribute("aria-hidden", "false");

      await page.getByRole("button", { name: "Close sidebar" }).click();
      await expect(body).toHaveClass(/sidebar-closed/);

      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await searchInput.fill("Archive");
      await expect(sessionItem(page, ARCHIVE_SESSION_TITLE, 2)).toBeVisible();
      await sessionItem(page, ARCHIVE_SESSION_TITLE, 2).click();

      await expect(body).toHaveClass(/sidebar-closed/);
      await expect(activeConversation(page).getByRole("heading", { name: ARCHIVE_SESSION_TITLE })).toBeVisible();
      await expect(composer(page)).toHaveValue("");

      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await searchInput.fill("");
      await sessionItem(page, SECONDARY_SESSION_TITLE, 2).click();

      await expect(body).toHaveClass(/sidebar-closed/);
      await expect(activeConversation(page).getByRole("heading", { name: SECONDARY_SESSION_TITLE })).toBeVisible();
      await expect(composer(page)).toHaveValue("");
    });
  });

  test("extension widgets remain stable and per-message edit and fork flows stay safe", async ({ page }) => {
    test.setTimeout(60_000);
    await openApp(page, { expectedSessionCount: 3 });

    const initialSessionCount = await sessionItems(page).count();
    const messageRow = toolMessageRow(page);
    const composerInput = composer(page);

    await composerInput.fill("/fixture");

    const extensionCommand = page.locator(".pp-slash-command-item").filter({ hasText: "/fixture-ui" }).first();
    await expect(extensionCommand).toContainText("Extension");
    await extensionCommand.click();
    await expect(composerInput).toHaveValue("/fixture-ui ");

    await composerInput.press("Enter");

    await expect(page.locator(".pp-toast").filter({ hasText: "Extension fixture rendered" }).first()).toBeVisible();
    await expect(page.locator("text=legacy-widget")).toBeVisible();
    await expect(page.locator("text=Legacy string widget content")).toBeVisible();
    await expect(page.locator("text=below-widget")).toBeVisible();
    await expect(page.locator(".pp-statusbar")).toContainText("fixture-ui: Extension status ready");
    await expect(composerInput).toHaveValue("Composer text set from /fixture-ui");
    await expect(page).toHaveTitle("Fixture extension title");
    await expect(page.locator("text=broken-widget")).toHaveCount(0);
    await expect(page.locator(".pp-error")).toHaveCount(0);

    await messageRow.scrollIntoViewIfNeeded();
    await messageRow.hover();
    await messageRow.getByRole("button", { name: "Edit prompt from here" }).click({ force: true });
    await expect(page.locator(".pp-info")).toContainText("Edit opened a safe fork");
    await expect(composerInput).toHaveValue(EDIT_FORK_PROMPT);
    await expect(composerInput).toBeFocused();
    await expect(sessionItems(page)).toHaveCount(initialSessionCount + 1);

    await sessionItem(page, PRIMARY_SESSION_TITLE, 7).click();
    await expect(activeConversation(page).getByRole("heading", { name: PRIMARY_SESSION_TITLE })).toBeVisible();

    const originalMessageRow = toolMessageRow(page);
    await originalMessageRow.scrollIntoViewIfNeeded();
    await originalMessageRow.hover();
    await originalMessageRow.getByRole("button", { name: "Fork from here" }).click({ force: true });
    await expect(page.locator(".pp-info")).toContainText("Fork created");
    await expect(composerInput).toHaveValue(EDIT_FORK_PROMPT);
    await expect(sessionItems(page)).toHaveCount(initialSessionCount + 2);
  });
});
