import AxeBuilder from "@axe-core/playwright";
import type { MapVetoState, MatchRecoveryIncident } from "@aftertick/contracts";
import { B2G_RELEASE, LAUNCHER_DOWNLOAD_FILENAME, LAUNCHER_DOWNLOAD_URL } from "@aftertick/contracts";
import { expect, test, type Page } from "@playwright/test";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

async function expectWcag(page: Page, state: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const summary = violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      html: node.html,
      failureSummary: node.failureSummary
    }))
  }));
  expect(summary, `${state} has WCAG A/AA violations`).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  // The web queue survives only as a development-only rollback harness. The
  // production root is launcher-first and has no browser matchmaking action.
  await page.goto("/?legacy_queue=1");
  await expect(page.getByRole("button", { name: /E2E Player/ })).toBeVisible();

  const reset = page.getByRole("button", { name: "Reset", exact: true });
  if (await reset.isVisible()) await reset.click();
  await expect(page.getByRole("button", { name: "Find a Match" })).toBeVisible();
});

test("makes the production root a launcher-first account and history surface", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your next match starts inside CS:GO." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find a Match" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: `Download launcher ${B2G_RELEASE.launcherVersion}` })).toHaveAttribute(
    "href",
    LAUNCHER_DOWNLOAD_URL
  );
  await expect(page.getByText(/use Official Matchmaking in Panorama/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent matches" })).toBeVisible();
  await expectWcag(page, "launcher-first account home");
  await page.screenshot({ path: ".artifacts/playwright/launcher-first-home-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 375, height: 844 });
  await page.reload();
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  await page.screenshot({ path: ".artifacts/playwright/launcher-first-home-mobile.png", fullPage: true });
});

test("guides launcher setup and recovers from clipboard denial on small screens", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Setup and recovery" }).click();
  const dialog = page.getByRole("dialog", { name: "Launcher & Setup" });
  await expect(dialog.getByRole("heading", { name: "Connect Account & Play" })).toBeVisible();
  await expect(dialog.getByRole("link", { name: `Download ${B2G_RELEASE.launcherVersion}` }))
    .toHaveAttribute("href", LAUNCHER_DOWNLOAD_URL);
  await expectWcag(page, "launcher setup desktop");
  await page.screenshot({ path: ".artifacts/playwright/launcher-setup-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 320, height: 740 });
  await dialog.getByText("View Launcher CLI Commands & Options").click();
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")) }
  }));
  const copy = dialog.getByRole("button", { name: "Copy doctor command" });
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("status")).toHaveText(/Could not copy.*copy it manually/);
  await expect(copy).toHaveText("Copy");
  const widths = await dialog.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  await expectWcag(page, "launcher setup mobile clipboard error");
  await page.screenshot({ path: ".artifacts/playwright/launcher-setup-mobile.png", fullPage: true });

  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => Promise.resolve() }
  }));
  await copy.click();
  await expect(dialog.getByRole("status")).toHaveText("Command copied.");
  await expect(copy).toHaveText("Copied!");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Setup and recovery" })).toBeFocused();
});

test("approves a launcher pairing from the signed-in browser session", async ({ page }) => {
  await page.route("**/api/bootstrap", async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.player.onboardingRequired = true;
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/launcher/v1/device/approve", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ userCode: "B2G4-PLAY" });
    expect(route.request().headers()["x-csrf-token"]).toBeTruthy();
    await route.fulfill({
      status: 200,
      json: {
        version: 1,
        status: "approved",
        userCode: "B2G4-PLAY",
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
      }
    });
  });

  await page.goto("/?launcher_code=b2g4-play");
  const dialog = page.getByRole("dialog", { name: "Connect this launcher" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Launcher code B2G4-PLAY")).toBeVisible();
  await expectWcag(page, "launcher authorization dialog");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.screenshot({path:".artifacts/playwright/launcher-auth-desktop.png",fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await expectWcag(page,"launcher authorization mobile");
  await page.screenshot({path:".artifacts/playwright/launcher-auth-mobile.png",fullPage:true});

  await dialog.getByRole("button", { name: "Connect Launcher" }).click();
  await expect(page.getByRole("dialog", { name: "Launcher connected" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("disables malformed launcher approval and keeps valid-code retries available",async({page})=>{
  await page.goto("/?launcher_code=bad-code");
  await expect(page.getByRole("button",{name:"Connect Launcher"})).toBeDisabled();
  let attempts=0;
  await page.route("**/api/launcher/v1/device/approve",async route=>{
    attempts++;
    await route.fulfill(attempts===1?{status:503,json:{error:"Try again shortly."}}:{status:200,json:{version:1,status:"approved"}});
  });
  await page.goto("/?launcher_code=B2G4-PLAY");
  const approve=page.getByRole("button",{name:"Connect Launcher"});
  await approve.click();await expect(page.getByRole("alert")).toContainText("Try again shortly.");
  await expect(approve).toBeEnabled();await approve.click();
  await expect(page.getByRole("dialog",{name:"Launcher connected"})).toBeVisible();
});

test("queues, accepts, persists assignment, and resets", async ({ page }) => {
  await page.getByLabel("Region").selectOption("EU Central");
  await page.getByRole("button", { name: "Find a Match" }).click();
  await expect(page.getByRole("button", { name: "Leave Queue" })).toBeVisible();

  const dialog = page.getByRole("dialog", { name: "Confirm your slot" });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText("9/10")).toBeVisible();
  await dialog.getByRole("button", { name: "Accept Match" }).click();

  await expect(page.getByRole("link", { name: /Open launcher/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open CS:GO manually" })).toHaveAttribute(
    "href",
    "steam://rungameid/4465480"
  );
  await expect(page.getByText("127.0.0.1:27015", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("link", { name: /Open launcher/ })).toBeVisible();
  await expect(page.getByText("10/10")).toHaveCount(0);

  await page.getByRole("button", { name: "Reset demo" }).click();
  await expect(page.getByRole("button", { name: "Find a Match" })).toBeVisible();
});

test("requires at least one map", async ({ page }) => {
  for (const map of ["Mirage", "Inferno", "Nuke", "Overpass", "Vertigo", "Ancient", "Anubis"]) {
    await page.getByRole("button", { name: map, exact: true }).click();
  }

  await expect(page.getByText("Select at least one map to search.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Find a Match" })).toBeDisabled();
});

test("fits a mobile viewport without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Find a Match" })).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);

  await page.getByRole("row", { name: /Open Inferno match/ }).click();
  await expect(page.getByRole("dialog", { name: /Inferno/ })).toBeVisible();
  const dialogDimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dialogDimensions.scrollWidth).toBeLessThanOrEqual(dialogDimensions.clientWidth);
});

test("passes automated WCAG 2.2 A/AA checks in core player states", async ({ page }) => {
  await expectWcag(page, "authenticated dashboard");

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to queue" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#queue")).toBeFocused();

  await page.getByRole("button", { name: /E2E Player/ }).click();
  await expectWcag(page, "account menu");
  await page.getByRole("button", { name: /View profile/ }).click();
  await expect(page.getByRole("region", { name: "E2E Player" })).toBeVisible();
  await expectWcag(page, "player profile page");
  await page.getByRole("button", { name: "Back", exact: true }).click();

  await page.getByRole("button", { name: "Ladder" }).click();
  await expectWcag(page, "leaderboard dialog");
  await page.getByRole("dialog", { name: "Leaderboard" })
    .getByRole("button", { name: "Close dialog" }).click();

  await page.getByRole("row", { name: /Open Inferno match/ }).click();
  await expectWcag(page, "match evidence dialog");
  await page.getByRole("dialog", { name: /Inferno/ })
    .getByRole("button", { name: "Report Test Player 02" }).click();
  await expectWcag(page, "player report dialog");
  await page.getByRole("dialog", { name: "Report Test Player 02" })
    .getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Find a Match" }).click();
  const ready = page.getByRole("dialog", { name: "Confirm your slot" });
  await expect(ready).toBeVisible({ timeout: 10_000 });
  await expectWcag(page, "ready-check dialog");
  await ready.getByRole("button", { name: "Decline" }).click();

  await page.setViewportSize({ width: 375, height: 844 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Find a Match" })).toBeVisible();
  await expectWcag(page, "mobile authenticated dashboard");
});

test("lets the acting captain complete an accessible, reload-safe map veto", async ({ page }) => {
  const matchId = "80000000-0000-4000-8000-000000000001";
  let veto: MapVetoState = {
    version: 1,
    matchId,
    region: "NA Central",
    captains: {
      alpha: "10000000-0000-4000-8000-000000000001",
      bravo: "10000000-0000-4000-8000-000000000002"
    },
    actingTeam: "alpha",
    remainingMaps: ["Mirage", "Nuke"],
    bans: [],
    status: "active",
    selectedMap: null,
    expiresAt: new Date(Date.now() + 30_000).toISOString()
  };
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as Record<string, unknown>;
    await route.fulfill({ response, json: {
      ...body,
      queue: {
        phase: "map-veto",
        joinedAt: new Date().toISOString(),
        regions: ["NA Central"],
        maps: ["Mirage", "Nuke"],
        playersFound: 10,
        estimatedWaitSeconds: 0,
        ratingWindow: 50
      },
      readyCheck: null,
      mapVeto: veto,
      assignment: null
    } });
  });
  await page.route(`**/api/matches/${matchId}/veto`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ map: "Nuke" });
    veto = {
      ...veto,
      remainingMaps: ["Mirage"],
      bans: [{
        sequence: 1,
        map: "Nuke",
        team: "alpha",
        captainPlayerId: veto.captains.alpha,
        automated: false,
        createdAt: new Date().toISOString()
      }],
      status: "allocating",
      selectedMap: "Mirage",
      expiresAt: null
    };
    await route.fulfill({ json: veto });
  });

  await page.reload();
  const dialog = page.getByRole("dialog", { name: "Ban one map" });
  await expect(dialog).toBeVisible();
  await expectWcag(page, "active captain map-veto dialog");
  await dialog.getByRole("button").filter({ hasText: "Nuke" }).click();
  await expect(page.getByRole("dialog", { name: "Preparing your server" })).toBeVisible();
  await expect(page.getByText("Mirage survived the veto.")).toBeVisible();
  await expectWcag(page, "allocating map-veto dialog");

  await page.reload();
  await expect(page.getByRole("dialog", { name: "Preparing your server" })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 844 });
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test("opens profiles, the regional ladder, and canonical match evidence", async ({ page }) => {
  await page.getByRole("button", { name: /E2E Player/ }).click();
  const accountMenu = page.getByRole("dialog", { name: "Account menu" });
  await expect(accountMenu).toBeVisible();
  await accountMenu.getByRole("button", { name: /View profile/ }).click();
  const profile = page.getByRole("region", { name: "E2E Player" });
  await expect(profile).toBeVisible();
  await expect(profile.getByText("1,937 Elo")).toBeVisible();
  await expect(profile.getByRole("img", { name: "Rating changed from 1900 to 1937" })).toBeVisible();
  await expect(profile.getByRole("heading", { name: "Recent matches" })).toBeVisible();
  await profile.getByRole("button", { name: "Back" }).click();

  await page.getByRole("button", { name: "Ladder" }).click();
  const ladder = page.getByRole("dialog", { name: "Leaderboard" });
  await expect(ladder).toBeVisible();
  await expect(ladder.getByRole("row", { name: /1 E2E Player/ })).toBeVisible();
  await expect(ladder.getByRole("row")).toHaveCount(11);
  await ladder.getByRole("button", { name: "Close dialog" }).click();

  await page.getByRole("row", { name: /Open Inferno match/ }).click();
  const match = page.getByRole("dialog", { name: /Inferno/ });
  await expect(match).toBeVisible();
  await expect(match.getByRole("table", { name: "Alpha statistics" })).toBeVisible();
  await expect(match.getByRole("table", { name: "Bravo statistics" })).toBeVisible();
  await expect(match.getByText(/analyzed · 0\.4 MB · SHA-256/)).toBeVisible();
  await match.getByRole("button", { name: "Report Test Player 02" }).click();
  const report = page.getByRole("dialog", { name: "Report Test Player 02" });
  await expect(report).toBeVisible();
  await expect(report.getByLabel("Category")).toHaveValue("griefing");
  await expect(report.getByLabel(/What happened/)).toBeVisible();
});

test("moves settings into the account menu and loads the complete match archive", async ({ page }) => {
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Settings" })).toHaveCount(0);
  await page.getByRole("button", { name: /E2E Player/ }).click();
  await page.getByRole("button", { name: /Account settings/ }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await page.getByRole("button", { name: "Matches" }).click();
  await expect(page.getByRole("heading", { name: "All matches" })).toBeVisible();
  await expect(page.getByText("1/143", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Load more · 142 remaining/ })).toBeVisible();
});

test("keeps page and modal scrolling usable", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 640 });
  await page.reload();
  await expect(page.getByRole("row", { name: /Open Inferno match/ })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.scrollingElement?.scrollHeight ?? document.documentElement.scrollHeight));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await page.getByRole("row", { name: /Open Inferno match/ }).click();
  const dialog = page.getByRole("dialog", { name: /Inferno/ });
  await expect(dialog).toBeVisible();
  const dialogScrollable = await dialog.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop > 0 && element.scrollHeight > element.clientHeight;
  });
  expect(dialogScrollable).toBe(true);
  await dialog.getByRole("button", { name: "Close dialog" }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("creates and operates an accessible party", async ({ page }) => {
  await page.getByRole("button", { name: "Create party" }).click();
  const party = page.getByRole("region", { name: /Party 1\/5/ });
  await expect(party.getByText("1/5", { exact: true })).toBeVisible();
  await expect(party.getByText("Ready", { exact: true }).first()).toBeVisible();
  await expect(party.getByRole("img", { name: "Distinguished Master Guardian rank" })).toBeVisible();
  await expect(party.getByText(/DMG · 1,937 Elo/)).toBeVisible();

  await page.getByLabel("Invite by player ID").fill("second-test-player");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.getByText("Party invite sent.")).toBeVisible();

  await page.getByRole("button", { name: "Mark not ready" }).click();
  await expect(page.getByRole("button", { name: "Mark ready" })).toBeVisible();
  await page.getByRole("button", { name: "Mark ready" }).click();
  await expect(page.getByRole("button", { name: "Mark not ready" })).toBeVisible();
  await page.screenshot({ path: ".artifacts/playwright/party-desktop.png", fullPage: true });
});

test("gates queue entry on a fresh signed route measurement", async ({ page }) => {
  let fresh = false;
  await page.route("**/api/latency-probes", (route) => route.fulfill({ json: {
    enabled: true,
    regions: ["NA Central"],
    measurements: fresh ? [{
      region: "NA Central",
      server: "game-na.example.test:27015",
      requestedSamples: 5,
      successfulSamples: 5,
      medianMs: 18.2,
      p95Ms: 24.7,
      packetLossPercent: 0,
      measuredAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 15 * 60_000).toISOString()
    }] : []
  } }));

  await page.reload();
  await expect(page.getByText("Route check required")).toBeVisible();
  await expect(page.getByRole("button", { name: "Measure" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find a Match" })).toBeDisabled();
  await expectWcag(page, "route measurement required");

  fresh = true;
  await page.reload();
  await expect(page.getByText("24.7 ms p95")).toBeVisible();
  await expect(page.getByText("5/5 replies · 0.0% loss")).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Find a Match" })).toBeEnabled();

  await page.setViewportSize({ width: 375, height: 844 });
  await page.reload();
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test("offers launcher recovery when a route-check handoff does not respond", async ({ page }) => {
  await page.route("**/api/latency-probes", (route) => route.fulfill({ json: {
    enabled: true,
    regions: ["NA Central"],
    measurements: []
  } }));
  await page.route("**/api/latency-probes/challenges", (route) => route.fulfill({
    status: 201,
    json: {
      version: 1,
      challengeId: "90000000-0000-4000-8000-000000000001",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      endpoints: [{ region: "NA Central", server: "game-na.example.test:27015", samples: 5 }],
      launcherUrl: "#launcher-test"
    }
  }));

  await page.reload();
  await page.getByRole("radio", { name: /Deathmatch/ }).click();
  await expect(page.getByRole("button", { name: "Join Deathmatch" })).toBeDisabled();
  await page.getByRole("button", { name: "Measure" }).click();
  await expect(page.getByText("Measuring route…")).toBeVisible();
  await expect(page.getByText("Launcher hasn’t responded")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("link", { name: "Open again" })).toHaveAttribute("href", "#launcher-test");
  await expect(page.getByText(/run the downloaded launcher once/i)).toBeVisible();
  await expectWcag(page, "launcher handoff recovery");

  await page.getByRole("button", { name: "View launcher setup guide" }).click();
  const launcherGuide = page.getByRole("dialog", { name: "Launcher & Setup" });
  await expect(launcherGuide).toBeVisible();
  await expect(launcherGuide.getByRole("link", { name: `Download ${B2G_RELEASE.launcherVersion}` })).toHaveAttribute(
    "href",
    LAUNCHER_DOWNLOAD_URL
  );
  await expect(launcherGuide.getByRole("link", { name: `Download ${B2G_RELEASE.launcherVersion}` })).toHaveAttribute(
    "download",
    LAUNCHER_DOWNLOAD_FILENAME
  );
  await expect(launcherGuide.getByText(/Unknown publisher/i)).toBeVisible();
  await expectWcag(page, "unsigned launcher setup guide");
  await launcherGuide.getByRole("button", { name: "Close dialog" }).click();

  await page.screenshot({ path: ".artifacts/playwright/launcher-handoff-desktop.png", fullPage: true });

  await page.setViewportSize({ width: 375, height: 844 });
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  await page.screenshot({ path: ".artifacts/playwright/launcher-handoff-mobile.png", fullPage: true });
});

test("renders the role-gated administrator operations workflow", async ({ page }) => {
  const now = "2026-08-29T20:00:00.000Z";
  const controls = {
    registrationEnabled: true,
    queueEnabled: true,
    serverAllocationEnabled: true,
    userMessage: null,
    version: 1,
    updatedAt: now
  };
  let recoveryIncident: MatchRecoveryIncident = {
    id: "70000000-0000-4000-8000-000000000001",
    matchId: "20000000-0000-4000-8000-000000000002",
    map: "Mirage",
    region: "NA Central",
    matchStatus: "disputed",
    reason: "server_lease_expired",
    status: "open",
    evidence: { serverAddress: "127.0.0.1:27015", previousMatchStatus: "live" },
    detectedAt: now,
    resolutionAction: null,
    resolutionNote: null,
    resolvedBy: null,
    resolvedAt: null,
    replacementMatchId: null,
    replacementAssignment: null,
    queueReassignedPlayers: 0,
    queueDeliveryError: null,
    resolutionError: null
  };
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { player: Record<string, unknown> };
    await route.fulfill({ response, json: {
      ...body,
      player: { ...body.player, platformRole: "admin" }
    } });
  });
  await page.route("**/api/moderation/reports?*", (route) => route.fulfill({ json: { reports: [{
    id: "30000000-0000-4000-8000-000000000001",
    reporterId: "10000000-0000-4000-8000-000000000001",
    reportedId: "10000000-0000-4000-8000-000000000002",
    reportedDisplayName: "Test Player 02",
    matchId: "20000000-0000-4000-8000-000000000001",
    category: "griefing",
    status: "pending",
    description: "Repeatedly blocked teammates in spawn.",
    reviewerId: null,
    resolution: null,
    createdAt: now,
    resolvedAt: null
  }] } }));
  await page.route("**/api/moderation/appeals?*", (route) => route.fulfill({ json: { appeals: [{
    id: "40000000-0000-4000-8000-000000000001",
    sanctionId: "50000000-0000-4000-8000-000000000001",
    playerId: "10000000-0000-4000-8000-000000000002",
    displayName: "Test Player 02",
    statement: "Please review the full demo and round timeline.",
    status: "pending",
    reviewerId: null,
    resolution: null,
    createdAt: now,
    resolvedAt: null
  }] } }));
  await page.route("**/api/moderation/anticheat-signals", (route) => route.fulfill({ json: { signals: [{
    id: "80000000-0000-4000-8000-000000000001",
    matchId: "20000000-0000-4000-8000-000000000001",
    playerId: "10000000-0000-4000-8000-000000000002",
    steamId: "76561198000000002",
    displayName: "Test Player 02",
    module: "smac_aimbot.smx",
    detectionType: 100,
    mode: "competitive",
    map: "Inferno",
    matchStatus: "completed",
    occurredAt: now,
    automaticAction: false
  }] } }));
  await page.route("**/api/admin/controls", async (route) => {
    if (route.request().method() === "PATCH") {
      const update = route.request().postDataJSON() as typeof controls;
      await route.fulfill({ json: { ...update, version: 2, updatedAt: now } });
      return;
    }
    await route.fulfill({ json: controls });
  });
  await page.route("**/api/admin/audit", (route) => route.fulfill({ json: { entries: [{
    id: "60000000-0000-4000-8000-000000000001",
    actorId: "10000000-0000-4000-8000-000000000001",
    action: "platform.controls.updated",
    targetType: "platform",
    targetId: null,
    detail: { queueEnabled: true, version: 1 },
    ipAddress: "127.0.0.1",
    createdAt: now
  }] } }));
  await page.route("**/api/admin/match-recovery**", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { action: "remake" | "void"; note: string };
      recoveryIncident = {
        ...recoveryIncident,
        matchStatus: "cancelled",
        status: "resolved",
        resolutionAction: body.action,
        resolutionNote: body.note,
        resolvedBy: "10000000-0000-4000-8000-000000000001",
        resolvedAt: now
      };
      return route.fulfill({ json: recoveryIncident });
    }
    return route.fulfill({ json: { incidents: [recoveryIncident] } });
  });

  await page.reload();
  await page.getByRole("button", { name: "Ops" }).click();
  const dialog = page.getByRole("dialog", { name: "Platform operations" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Test Player 02")).toBeVisible();
  await expect(dialog.getByText("Repeatedly blocked teammates in spawn.")).toBeVisible();

  await dialog.getByRole("button", { name: /signals \(1\)/ }).click();
  await expect(dialog.getByText("Server-side heuristic signal only.", { exact: false })).toBeVisible();

  await dialog.getByRole("button", { name: /appeals \(1\)/ }).click();
  await expect(dialog.getByText("Please review the full demo and round timeline.")).toBeVisible();

  await dialog.getByRole("button", { name: /recovery \(1\)/ }).click();
  await expect(dialog.getByText("Server lease expired", { exact: false })).toBeVisible();
  await dialog.getByLabel("Operator finding").fill("The failed live server invalidated the competitive result.");
  await dialog.getByRole("button", { name: "Void without rating" }).click();
  await expect(dialog.getByText("Resolved as")).toContainText("void");

  await dialog.getByRole("button", { name: "controls", exact: true }).click();
  await dialog.getByLabel("New queue entries enabled").uncheck();
  await dialog.getByRole("button", { name: /Save controls/ }).click();
  await expect(dialog.getByRole("button", { name: /v2/ })).toBeVisible();

  await dialog.getByRole("button", { name: "audit", exact: true }).click();
  await expect(dialog.getByText("platform.controls.updated")).toBeVisible();
  await expectWcag(page, "administrator operations dialog");
});
