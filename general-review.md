# Pi Web UI Review

Date: 2026-03-28
URL: http://127.0.0.1:3310/
Method: manual dogfooding with `agent-browser` on desktop and mobile-sized viewports

## Overall read

The app already has a strong foundation: the base dark theme is coherent, the information density is good, the session sidebar feels fast, dense mode stays usable, and the light theme looks clean once the default palette is used. The weak spots are mostly around navigation semantics, onboarding, and a few places where backend/state details leak straight into the UI.

## Severity summary

| Severity | Count |
|---|---:|
| High | 2 |
| Medium | 5 |
| Low | 1 |
| Total | 8 |

## Findings

### 1. Global overflow menu opens in the wrong place
- Severity: Medium
- Category: UX / visual
- What happens: clicking the top-right `...` menu opens a dropdown on the far left under the logo/sidebar instead of near the trigger.
- Why it matters: it breaks spatial continuity and makes the menu feel disconnected from the control that opened it.
- Evidence: `.tmp/ui-review/screenshots/menu-desktop-plain.png`, `.tmp/ui-review/screenshots/menu-mobile.png`

### 2. `Settings` opens session actions instead of app settings
- Severity: High
- Category: Functional / UX
- What happens: the global menu item labeled `Settings` opens a modal titled `Session actions` with rename, navigate-tree, and fork controls.
- Why it matters: the control label and the destination do not match; users looking for app settings land in session-specific management instead.
- Evidence: `.tmp/ui-review/screenshots/settings-page-desktop.png`, `.tmp/ui-review/screenshots/settings-mobile-result.png`

### 3. Sending without a model shows raw server JSON and internal paths
- Severity: High
- Category: UX / console
- What happens: submitting a prompt with `No model` selected surfaces a red banner containing raw `500` JSON plus a local `node_modules/.../providers.md` path.
- Why it matters: this blocks the core message flow with a technical, intimidating error and leaks implementation details that should never be shown in product UI.
- Evidence: `.tmp/ui-review/screenshots/send-no-model-existing-session.png`

### 4. New sessions expose storage filenames instead of human-friendly titles
- Severity: Medium
- Category: Content / UX
- What happens: a newly created session appears as a timestamp/UUID-like filename in the sidebar and header.
- Why it matters: the UI immediately feels backend-driven rather than user-driven, and the first-run empty state looks unfinished.
- Evidence: `.tmp/ui-review/screenshots/new-session-desktop.png`

### 5. Sidebar filtering can hide the currently open conversation
- Severity: Medium
- Category: UX
- What happens: filtering the sidebar to `archive` leaves the main panel on `Playwright harness smoke fixture`, even though that session is no longer visible in the filtered list.
- Why it matters: the current selection becomes impossible to reconcile with the navigation state, which is disorienting.
- Evidence: `.tmp/ui-review/screenshots/search-archive.png`

### 6. `Appearance: Light` can still render a dark-looking UI
- Severity: Medium
- Category: UX / visual
- What happens: with the `Ghostty` color theme active, selecting `Light` still leaves the overall interface visually dark; only switching the color theme back to `Default` produces a true light UI.
- Why it matters: the selected state says `Light`, but the result does not look light, so the controls read as broken or contradictory.
- Evidence: `.tmp/ui-review/screenshots/light-theme-closed-desktop.png`, `.tmp/ui-review/screenshots/light-theme-default-color.png`

### 7. Model picker empty state is a dead end
- Severity: Medium
- Category: UX
- What happens: clicking `No model` opens a modal that says `No models match your search.` even when the search box is empty, and it gives no setup CTA.
- Why it matters: new users get no path forward until they hit the separate send error, which is too late and much rougher.
- Evidence: `.tmp/ui-review/screenshots/model-picker-desktop.png`

### 8. Mobile message actions are too exposed and crowd the thread
- Severity: Low
- Category: UX / responsive
- What happens: on mobile, each message shows `Copy / Retry / Edit / Fork` inline, stacking utility controls directly into the reading flow.
- Why it matters: the chat feels busier than it needs to, important content starts lower on the page, and the composer area feels tighter.
- Evidence: `.tmp/ui-review/screenshots/home-mobile-plain.png`

## Strong points

- The baseline dark theme is consistent and legible.
- Session browsing/search feels responsive and the sidebar hierarchy is easy to parse.
- Dense mode still holds together visually without obvious overlap or collapse.
- The light theme with the default palette is clean and balanced: `.tmp/ui-review/screenshots/light-theme-default-color.png`.
- Session-action capabilities themselves are useful; the main issue is discoverability/labeling, not the feature depth.

## Highest-value fixes

1. Fix onboarding around model selection: improve the empty-state modal and replace the raw `500` banner with actionable UI.
2. Separate global settings from session actions, both in labeling and in routing.
3. Anchor the global overflow menu to the trigger on both desktop and mobile.
4. Give new sessions a friendly temporary title until the user renames them or the first prompt generates one.
5. Keep the filtered sidebar and active conversation state aligned.
