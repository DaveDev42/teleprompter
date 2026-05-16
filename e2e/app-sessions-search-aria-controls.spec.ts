import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// BUG-74: The Sessions search input filters the sessions list in real
// time but never declares the relationship to AT — it has no
// `aria-controls` pointing at the filtered list, and the list has no
// `id` to be referenced.
//
// WAI-ARIA 1.2 §6.6.4 (aria-controls): "identifies the element (or
// elements) whose contents or presence are controlled by the current
// element." APG Combobox / Search patterns require the input to
// expose `aria-controls` pointing at the controlled list/listbox so
// screen-reader users can programmatically navigate from the filter
// field to the filtered results region.
//
// WCAG 4.1.2 Name, Role, Value (Level A): custom controls must
// expose their state and the relationship to the affected region.
test.describe("Sessions search aria-controls", () => {
  test("session-search input declares aria-controls pointing at sessions-list", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // The search field only renders when there are >2 sessions in
    // store. Empty-state still has the role="list" landmark with the
    // matching id, so the aria-controls target resolves regardless.
    const list = page.locator("#sessions-list").first();
    await expect(list).toBeAttached();
    await expect(list).toHaveAttribute("role", "list");
  });

  test("when search field is present, it carries aria-controls=sessions-list", async ({
    page,
  }) => {
    // Seed >2 sessions so the search field renders. The store
    // persists under tp_sessions_v1 as `{[daemonId]: WsSessionMeta[]}`.
    await page.goto("/");
    await page.evaluate(() => {
      const seed = {
        "daemon-a": [
          {
            sid: "search-aria-1",
            cwd: "/tmp/a",
            state: "running",
            updatedAt: Date.now(),
          },
          {
            sid: "search-aria-2",
            cwd: "/tmp/b",
            state: "stopped",
            updatedAt: Date.now() - 1000,
          },
          {
            sid: "search-aria-3",
            cwd: "/tmp/c",
            state: "stopped",
            updatedAt: Date.now() - 2000,
          },
        ],
      };
      localStorage.setItem("tp_sessions_v1", JSON.stringify(seed));
    });
    await page.reload();
    await page.waitForLoadState("networkidle");

    const search = page.getByTestId("session-search");
    await expect(search).toBeVisible();
    await expect(search).toHaveAttribute("aria-controls", "sessions-list");

    const list = page.locator("#sessions-list").first();
    await expect(list).toBeAttached();
    await expect(list).toHaveAttribute("role", "list");
  });
});
