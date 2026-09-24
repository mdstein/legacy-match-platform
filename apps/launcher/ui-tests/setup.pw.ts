import { test, expect, type Page } from "@playwright/test";
import { fixture, refresh } from "./fixture";

async function watchSetup(page: Page) {
  await expect(page.locator(".setup-layout")).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    const setup = document.querySelector(".setup-layout")!;
    w.setupDetached = false;
    new MutationObserver(() => {
      if (!setup.isConnected) w.setupDetached = true;
    }).observe(document.querySelector("main")!, { childList: true, subtree: true });
  });
}

for (const fresh of [false, true]) {
  test(`${fresh ? "first installation" : "signed-out launch"} keeps setup mounted across status polls`, async ({ page }) => {
    await fixture(page, { signedOut: true, fresh, delays: { status: 80 } });
    await watchSetup(page);
    // Span two real polling intervals: a momentary visible assertion misses
    // the repeated setup/loading unmount that caused the reported strobe.
    await page.waitForTimeout(3300);
    expect(await page.evaluate(() => (window as any).setupDetached)).toBe(false);
    const calls = await page.evaluate(() => (window as any).fixture.calls);
    expect(calls.filter((c: any) => c.op === "status").length).toBeLessThanOrEqual(5);
    expect(calls.some((c: any) => c.op === "bootstrap")).toBe(false);
    await expect(page.locator(".play-button")).toHaveText(fresh ? "Install CS:GO" : "Connect Steam");
  });
}

test("signed-out Settings stays mounted and retains its dialog during refreshes", async ({ page }) => {
  await fixture(page, { signedOut: true, delays: { status: 80 } });
  await page.getByRole("navigation").getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Launcher preferences" })).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    const settings = document.querySelector('[data-page="settings"] .workspace')!;
    w.settingsDetached = false;
    new MutationObserver(() => {
      if (!settings.isConnected) w.settingsDetached = true;
    }).observe(document.querySelector("main")!, { childList: true, subtree: true });
  });
  await page.getByRole("button", { name: "Uninstall B2G", exact: true }).click();
  await page.waitForTimeout(3300);
  expect(await page.evaluate(() => (window as any).settingsDetached)).toBe(false);
  await expect(page.getByRole("dialog")).toContainText("Steam CS:GO, settings and demos are preserved");
  await page.keyboard.press("Escape");
  await refresh(page);
  await expect(page.getByRole("button", { name: "Run diagnostics" })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).fixture.calls.some((c: any) => ["account", "uninstall"].includes(c.op)))).toBe(false);
});

test("sign-out discards delayed status and account responses without clearing installation", async ({ page }) => {
  await fixture(page);
  await expect(page.getByRole("heading", { name: "Playtest player", exact: true })).toBeVisible();
  await page.getByRole("navigation").getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const s = (window as any).fixture;
    s.delays.status = 1800;
    s.delays.bootstrap = 2200;
    s.delays.account = 2200;
  });
  await refresh(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator(".play-button")).toHaveText("Connect Steam");
  await page.getByRole("navigation").getByRole("button", { name: "Play", exact: true }).click();
  await watchSetup(page);
  const reads = await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => ["account", "bootstrap"].includes(c.op)).length);
  await page.waitForTimeout(2800);
  expect(await page.evaluate(() => (window as any).setupDetached)).toBe(false);
  await expect(page.locator(".play-button")).toHaveText("Connect Steam");
  await expect(page.getByText("CS:GO is installed on this PC.")).toBeVisible();
  await expect(page.getByText("Playtest player", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => ["account", "bootstrap"].includes(c.op)).length)).toBe(reads);
});

test("Steam cancellation, slow profile sync and retry keep first-run setup stable", async ({ page }) => {
  await fixture(page, { signedOut: true, delays: { bootstrap: 1800 } });
  await watchSetup(page);
  await page.getByRole("button", { name: "Continue with Steam" }).click();
  await expect(page.getByText("ABCD-1234", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue with Steam" })).toBeEnabled();
  await page.getByRole("button", { name: "Continue with Steam" }).click();
  await page.evaluate(() => {
    const s = (window as any).fixture;
    s.status.paired = true;
    s.status.session.pairing = false;
    s.player.onboardingRequired = true;
    s.errors.bootstrap = "The connection was interrupted. Please retry.";
  });
  await refresh(page);
  await expect(page.getByText("Loading your B2G profile. Your setup will continue here.")).toBeVisible();
  await expect(page.locator(".play-button")).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("connection was interrupted");
  await page.evaluate(() => {
    const s = (window as any).fixture;
    delete s.errors.bootstrap;
    s.delays.bootstrap = 0;
    s.errors.onboard = "That player name is already taken. Choose another.";
  });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByLabel("B2G player name").fill("NewPlayer");
  await page.getByLabel("Your region").selectOption("NA West");
  await page.getByRole("button", { name: "Create B2G profile" }).click();
  await expect(page.getByRole("alert")).toContainText("already taken");
  await expect(page.getByLabel("B2G player name")).toHaveValue("NewPlayer");
  await expect(page.getByLabel("Your region")).toHaveValue("NA West");
  expect(await page.evaluate(() => (window as any).setupDetached)).toBe(false);
  await page.evaluate(() => { delete (window as any).fixture.errors.onboard; });
  await page.getByLabel("B2G player name").fill("NewPlayer2");
  await page.getByRole("button", { name: "Create B2G profile" }).click();
  await expect(page.getByRole("heading", { name: "NewPlayer2", exact: true })).toBeVisible();
  await expect(page.locator(".play-button")).toHaveText("Play");
});
