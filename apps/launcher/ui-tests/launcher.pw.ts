import { test, expect, type Page } from "@playwright/test";
import { fixture, refresh, me } from "./fixture";
const navigate = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Launcher" })
    .getByRole("button", { name, exact: true })
    .click();
const change = async (page: Page, script: (s: any) => void) => {
  await page.evaluate((script) => {
    (0, eval)(`(${script})`)((window as any).fixture);
  }, script.toString());
  await refresh(page);
};
test("signed-out players can access local diagnostics and uninstall confirmation",async({page})=>{
  await fixture(page,{signedOut:true});await navigate(page,"Settings");
  await expect(page.getByRole("heading",{name:"Launcher preferences"})).toBeVisible();
  await expect(page.getByRole("button",{name:"Run diagnostics"})).toBeEnabled();
  await page.getByRole("button",{name:"Uninstall B2G",exact:true}).click();
  await expect(page.getByRole("dialog")).toContainText("Steam CS:GO, settings and demos are preserved");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(()=>(window as any).fixture.calls.some((c:any)=>["account","uninstall"].includes(c.op)))).toBe(false);
});
test("a delayed response from the previous account cannot repopulate the launcher",async({page})=>{
  await fixture(page);await expect(page.getByRole("heading",{name:"Playtest player"})).toBeVisible();
  await page.evaluate(()=>{(window as any).fixture.delays.bootstrap=1200});await refresh(page);
  await navigate(page,"Settings");await page.getByRole("button",{name:"Sign out",exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:"Sign out",exact:true}).click();
  await expect(page.locator(".play-button")).toHaveText("Connect Steam");
  await change(page,s=>{s.player.id="55555555-5555-4555-8555-555555555555";s.player.displayName="Second player";s.status.paired=true});
  await navigate(page,"Play");await expect(page.getByRole("heading",{name:"Second player"})).toBeVisible();
  await expect(page.getByText("Playtest player",{exact:true})).toHaveCount(0);
});
async function compose(page: Page) {
  await navigate(page, "Trading");
  await page.getByRole("button", { name: "New trade", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Player name or trade code" })
    .fill("Maple");
  await page.getByRole("button", { name: "Find player", exact: true }).click();
  await page.locator(".player-row").filter({ hasText: "Maple" }).click();
  await expect(
    page.getByRole("heading", { name: "Trade with Maple", exact: true }),
  ).toBeVisible();
}
test("launch state survives polling, reload, and game exit; failure is actionable", async ({
  page,
}) => {
  await fixture(page);
  await expect(page.locator(".play-button")).toHaveText("Play");
  await page.locator(".play-button").click();
  await expect(page.locator(".play-button")).toHaveText("Starting");
  await expect(page.locator(".play-button")).toBeDisabled();
  await change(page, (s) => {
    s.status.gameOpen = true;
  });
  await expect(page.locator(".play-button")).toHaveText("Starting");
  await change(page, (s) => {
    s.status.session.phase = "running";
  });
  await expect(page.locator(".play-button")).toHaveText("In game");
  await change(page, (s) => {
    s.status.session.phase = "idle";
    s.status.gameOpen = false;
  });
  await expect(page.locator(".play-button")).toHaveText("Play");
  await change(page, (s) => {
    s.status.session.phase = "failed";
    s.status.session.message = "Close FACEIT Anti-Cheat, then press Play.";
  });
  await page.getByRole("button", { name: "Open Launch Help" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Close FACEIT Anti-Cheat",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".play-button")).toHaveText("Play");
});
test("slow status responses settle instead of being starved by polling", async ({
  page,
}) => {
  await fixture(page, { delays: { status: 2400 } });
  await expect(page.locator(".play-button")).toHaveText("Play");
  const calls = await page.evaluate(
    () =>
      (window as any).fixture.calls.filter((c: any) => c.op === "status")
        .length,
  );
  expect(calls).toBeLessThanOrEqual(2);
});
test("settings draft survives tab changes and only saves on explicit action", async ({
  page,
}) => {
  await fixture(page);
  await navigate(page, "Settings");
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Matchmaking", exact: true })
    .click();
  await page.getByLabel("Preferred region").selectOption("NA East");
  await navigate(page, "Trading");
  await navigate(page, "Settings");
  await expect(page.getByLabel("Preferred region")).toHaveValue("NA East");
  expect(
    await page.evaluate(
      () =>
        (window as any).fixture.calls.filter((c: any) => c.op === "settings")
          .length,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).fixture.player.region))
    .toBe("NA East");
});
test("trade selections survive search and tab changes; exact terms reach Rust once", async ({
  page,
}) => {
  await fixture(page);
  await compose(page);
  await page
    .getByRole("button", { name: "Select AK-47 | Redline", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Select AWP | Dragon Lore", exact: true })
    .click();
  const search = page.getByRole("textbox", { name: "Search Your inventory" });
  await search.fill("Glock");
  await expect(
    page.getByRole("button", { name: "Select AK-47 | Redline", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "AK-47 | Redline", exact: true }),
  ).toBeVisible();
  await navigate(page, "Friends");
  await navigate(page, "Trading");
  await expect(search).toHaveValue("Glock");
  await page.getByRole("button", { name: "Review trade", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Review your trade" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Send offer", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).fixture.calls.filter(
            (c: any) => c.op === "trade_mutate",
          ).length,
      ),
    )
    .toBe(1);
  const sent = await page.evaluate(
    () =>
      (window as any).fixture.calls.find((c: any) => c.op === "trade_mutate")
        .args.mutation,
  );
  expect(sent.terms.giveAssetIds).toEqual(["8000000000000000001"]);
  expect(sent.terms.receiveAssetIds).toEqual(["8000000000000000003"]);
  expect(Object.keys(sent.terms.itemFingerprints)).toHaveLength(2);
});
test("one-sided trade requires gift consent; ambiguous send retains recovery", async ({
  page,
}) => {
  await fixture(page);
  await compose(page);
  await page
    .getByRole("button", { name: "Select Glock-18 | Ironwork", exact: true })
    .click();
  await page.getByRole("button", { name: "Review trade", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Send offer", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", { name: /I understand this is a gift/ })
    .check();
  await change(page, (s) => {
    s.errors.trade_mutate =
      "The response was interrupted. Retry to recover its result.";
  });
  await page.getByRole("button", { name: "Send offer", exact: true }).click();
  await expect(page.locator(".recovery")).toContainText(/recover|pending/i);
  await expect(
    page.getByRole("button", { name: "Send offer", exact: true }),
  ).toBeDisabled();
});
test("changed incoming items cannot be accepted and revision changes clear gift consent", async ({
  page,
}) => {
  await fixture(page);
  await navigate(page, "Trading");
  await page.locator(".offer-row").first().click();
  await expect(
    page.getByRole("button", { name: "Accept trade", exact: true }),
  ).toBeEnabled();
  await change(page, (s) => {
    s.offer.changedAssetIds = [s.items[0].assetId];
  });
  await expect(
    page.getByRole("button", { name: "Accept trade", exact: true }),
  ).toBeDisabled();
  await change(page, (s) => {
    s.offer.items = [s.items[0]];
    s.offer.itemCount = 1;
    s.offer.changedAssetIds = [];
    s.offer.revision = 2;
  });
  await page.getByRole("checkbox", { name: /I understand/ }).check();
  await expect(
    page.getByRole("button", { name: "Accept trade", exact: true }),
  ).toBeEnabled();
  await change(page, (s) => {
    s.offer.revision = 3;
  });
  await expect(
    page.getByRole("checkbox", { name: /I understand/ }),
  ).not.toBeChecked();
});
test("fresh installation and in-launcher profile setup have clear next actions", async ({
  page,
}) => {
  await fixture(page, { fresh: true });
  await expect(page.locator(".play-button")).toHaveText("Install CS:GO");
  await page.locator(".play-button").click();
  await expect(page.locator(".play-button")).toHaveText("Installing");
  await change(page, (s) => {
    s.status.installation.ready = true;
    s.status.session.installing = false;
  });
  await expect(page.locator(".play-button")).toHaveText("Connect Steam");
  await page.locator(".play-button").click();
  await expect(page.getByText("ABCD-1234", { exact: true })).toBeVisible();
  await change(page, (s) => {
    s.status.paired = true;
    s.status.session.pairing = false;
    s.player.onboardingRequired = true;
  });
  await page.locator("#setup-name").fill("NewPlayer");
  await page.getByRole("button", { name: "Create B2G profile" }).click();
  await expect(page.locator(".play-button")).toHaveText("Play");
});
test("friend rejection releases the pending action and private profiles omit stats", async ({
  page,
}) => {
  await fixture(page);
  await change(page, (s) => {
    s.partner.relationship = "none";
    s.friendResult = {
      rejected: true,
      message: "This player is not accepting friend requests.",
    };
  });
  await navigate(page, "Friends");
  await page.locator(".player-row").first().click();
  await page.getByRole("button", { name: "Add friend", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("not accepting");
  await expect(
    page.getByRole("button", { name: "Add friend", exact: true }),
  ).toBeEnabled();
  await change(page, (s) => {
    s.partner.private = true;
  });
  await expect(
    page.getByRole("heading", { name: "This profile is private" }),
  ).toBeVisible();
  await expect(page.locator(".profile-stats")).toHaveCount(0);
});
test("match details keep the extended scoreboard and demo action; dialogs trap focus", async ({
  page,
}) => {
  await fixture(page);
  await navigate(page, "Match history");
  await page.getByRole("button", { name: "View match on de_dust2" }).click();
  await expect(
    page.getByRole("columnheader", { name: "Utility damage" }),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => !!document.activeElement?.closest("dialog")),
  ).toBe(true);
  await page.getByRole("button", { name: /Download demo/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).fixture.calls.filter((c: any) => c.op === "demo")
            .length,
      ),
    )
    .toBe(1);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "View match on de_dust2" }),
  ).toBeFocused();
});
