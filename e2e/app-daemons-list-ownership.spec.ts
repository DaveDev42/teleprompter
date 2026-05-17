import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1280, height: 800 } });

// Regression: the populated /daemons screen rendered daemon cards as
// role="group" directly inside a plain ScrollView, with no role="list"
// ancestor. ARIA 1.2 §5.3 + WCAG SC 1.3.1 (Info and Relationships,
// Level A): a collection of items requires a role="list" container so
// AT can announce "list, N items" and let users navigate item-by-item.
// Without it, NVDA/JAWS/VoiceOver announce each card in isolation with
// no positional context, and Firefox/Safari skip them under list-nav
// shortcuts.
//
// Fix: wrap the daemon card map in role="list" + role="listitem" with
// an accessible name, matching the sessions list ownership pattern
// already guarded by app-sessions-list-ownership.spec.ts.
test.describe("Daemons list role=list/listitem ownership", () => {
  test("populated daemons screen exposes role=list with listitem children", async ({
    page,
  }) => {
    // Seed two pairings so the populated branch renders. The store key
    // and shape come from `apps/app/src/stores/pairing-store.ts`.
    await page.addInitScript(() => {
      const dummy = "AAAA";
      const entries = [
        {
          daemonId: "test-daemons-list-ownership-1111aaaa",
          relayUrl: "wss://relay.example.com",
          relayToken: "token-1",
          registrationProof: "proof-1",
          daemonPublicKey: dummy,
          frontendPublicKey: dummy,
          frontendSecretKey: dummy,
          frontendId: "frontend-1",
          pairingSecret: dummy,
          pairedAt: Date.now(),
          label: "First Daemon",
          labelSource: "user",
        },
        {
          daemonId: "test-daemons-list-ownership-2222bbbb",
          relayUrl: "wss://relay.example.com",
          relayToken: "token-2",
          registrationProof: "proof-2",
          daemonPublicKey: dummy,
          frontendPublicKey: dummy,
          frontendSecretKey: dummy,
          frontendId: "frontend-2",
          pairingSecret: dummy,
          pairedAt: Date.now() - 1000,
          label: "Second Daemon",
          labelSource: "user",
        },
      ];
      localStorage.setItem("tp_pairings_v3", JSON.stringify(entries));
    });

    await page.goto("/daemons");
    await page.waitForLoadState("networkidle");

    // At least one daemon card must be visible — confirms the populated
    // branch rendered and the fixture seeded correctly.
    const cards = page.locator('[data-testid="daemon-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThanOrEqual(2);

    // The list container with an accessible name. Anchor on the
    // labelled list to avoid colliding with other unrelated lists in
    // the DOM (sessions list lives on a separate route, but defensive
    // selectors keep the spec robust against future cross-route render).
    const list = page.getByRole("list", { name: "Connected daemons" });
    await expect(list).toBeVisible();

    // Each daemon card must sit inside a role=listitem ancestor that
    // is itself inside the list.
    const items = list.locator('[role="listitem"]');
    const itemCount = await items.count();
    expect(itemCount).toBe(cardCount);

    // The listitems must be direct (or single-wrapper) children of the
    // list — same ARIA-context invariant guarded for the sessions list.
    const maxDepth = await page.evaluate(() => {
      const lists = Array.from(
        document.querySelectorAll<HTMLElement>('[role="list"]'),
      );
      const targetList = lists.find(
        (el) => el.getAttribute("aria-label") === "Connected daemons",
      );
      if (!targetList) return -1;
      const listItems = Array.from(
        targetList.querySelectorAll<HTMLElement>('[role="listitem"]'),
      );
      let worst = -1;
      for (const it of listItems) {
        let depth = 0;
        let node: Element | null = it.parentElement;
        while (node && node !== targetList) {
          depth++;
          node = node.parentElement;
        }
        if (depth > worst) worst = depth;
      }
      return worst;
    });

    // 0 = direct child (ideal). 1 = single wrapper (RN Web's ScrollView
    // emits one inner content wrapper, which is acceptable). ≥2 means
    // we regressed to FlatList-style nesting that drops listitems out
    // of the AX tree in Firefox/Safari.
    expect(maxDepth).toBeGreaterThanOrEqual(0);
    expect(maxDepth).toBeLessThanOrEqual(1);
  });
});
