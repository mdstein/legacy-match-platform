import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fixture, refresh } from "./fixture";
const navigate = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Launcher" })
    .getByRole("button", { name, exact: true })
    .click();
const captureRoot = path.resolve(".impeccable/review/tauri");
async function verifyLayout(page: Page) {
  await expect(page.locator(".app-shell")).toBeVisible();
  const issues = await page.evaluate(() => {
    const found: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1)
      found.push("document horizontal overflow");
    for (const root of document.querySelectorAll<HTMLElement>(
      ".topbar,.playbar,.page:not([hidden])",
    )) {
      if (root.scrollWidth > root.clientWidth + 1)
        found.push(`${root.className} horizontal overflow`);
    }
    for (const el of document.querySelectorAll<HTMLElement>(
      ".topbar button,.playbar button",
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (
        el.scrollWidth > el.clientWidth + 1 ||
        el.scrollHeight > el.clientHeight + 1
      )
        found.push(`clipped control: ${el.ariaLabel || el.textContent}`);
      if (
        r.left < 0 ||
        r.right > innerWidth ||
        r.top < 0 ||
        r.bottom > innerHeight
      )
        found.push(`control outside window: ${el.ariaLabel || el.textContent}`);
    }
    return found;
  });
  expect(issues).toEqual([]);
}
for (const size of [
  { width: 1360, height: 820 },
  { width: 960, height: 640 },
])
  test(`all tabs and trade flow fit ${size.width}×${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await fixture(page);
    await expect(page.locator(".play-button")).toHaveText("Play");
    await page.evaluate(() => document.fonts.ready);
    await mkdir(captureRoot, { recursive: true });
    for (const tab of [
      "Play",
      "Inventory",
      "Trading",
      "Match history",
      "Friends",
      "Settings",
    ]) {
      await navigate(page, tab);
      await expect(
        page.locator(".page:not([hidden]) .loading-state"),
      ).toHaveCount(0);
      await verifyLayout(page);
      await page
        .locator(".page:not([hidden])")
        .evaluate((el) => (el.scrollTop = 0));
      await page.screenshot({
        path: path.join(
          captureRoot,
          `${tab.toLowerCase().replaceAll(" ", "-")}-${size.width}.png`,
        ),
        animations: "disabled",
      });
    }
    await navigate(page, "Friends");
    await page.locator(".player-row").first().click();
    await expect(page.locator(".profile-stats")).toBeVisible();
    await verifyLayout(page);
    await page
      .locator(".page:not([hidden])")
      .evaluate((el) => (el.scrollTop = 0));
    await page.screenshot({
      path: path.join(captureRoot, `profile-${size.width}.png`),
      animations: "disabled",
    });
    await navigate(page, "Trading");
    await page.getByRole("button", { name: "New trade", exact: true }).click();
    await page.getByLabel("Player name or trade code").fill("Maple");
    await page
      .getByRole("button", { name: "Find player", exact: true })
      .click();
    await page.locator(".player-row").first().click();
    await expect(
      page.getByRole("button", { name: "Select AK-47 | Redline", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Select AK-47 | Redline", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Select AWP | Dragon Lore", exact: true })
      .click();
    await verifyLayout(page);
    await page
      .locator(".page:not([hidden])")
      .evaluate((el) => (el.scrollTop = 0));
    await page.locator(".trade-flow-body").evaluate((el) => (el.scrollTop = 0));
    await expect(
      page.getByRole("button", { name: "Review trade", exact: true }),
    ).toBeInViewport();
    const geometry = await page.evaluate(() => {
      const body = document
        .querySelector(".trade-flow-body")!
        .getBoundingClientRect();
      const footer = document
        .querySelector(".commit-row")!
        .getBoundingClientRect();
      return {
        overlap: body.bottom > footer.top + 1,
        completeRows: [
          ...document.querySelectorAll(".inventory .item-tile:first-child"),
        ].map((el) => el.getBoundingClientRect().bottom <= body.bottom + 1),
      };
    });
    expect(geometry.overlap).toBe(false);
    expect(geometry.completeRows).toEqual([true, true]);
    await page.screenshot({
      path: path.join(captureRoot, `compose-${size.width}.png`),
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "Review trade", exact: true })
      .click();
    await verifyLayout(page);
    await page
      .locator(".page:not([hidden])")
      .evaluate((el) => (el.scrollTop = 0));
    await expect(
      page.getByRole("button", { name: "Send offer", exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: path.join(captureRoot, `review-${size.width}.png`),
      animations: "disabled",
    });
    expect(errors).toEqual([]);
  });
test("reduced motion, hover animation and resize do not remount the interface", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await fixture(page);
  await expect(page.locator(".news-hero")).toBeVisible();
  await page.locator(".news-hero").hover();
  await expect
    .poll(() =>
      page
        .locator(".news-hero > img")
        .evaluate((el) => getComputedStyle(el).transform),
    )
    .not.toBe("none");
  for (const width of [960, 1024, 1200, 1360, 1920]) {
    await page.setViewportSize({ width, height: 820 });
    await verifyLayout(page);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      page
        .locator(".news-hero > img")
        .evaluate((el) => getComputedStyle(el).transform),
    )
    .toBe("none");
  await page.evaluate(() => {
    (window as any).fixture.status.session.phase = "starting";
  });
  await refresh(page);
  await expect(page.locator(".play-button")).toHaveText("Starting");
  expect(
    await page
      .locator(".spinner")
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
});

for (const size of [{ width: 1360, height: 820 }, { width: 960, height: 640 }]) {
  test(`first-run and signed-out settings fit ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await fixture(page, { fresh: true });
    await expect(page.locator(".setup-layout")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await mkdir(captureRoot, { recursive: true });
    const capture = async (name: string) => {
      await verifyLayout(page);
      await page.screenshot({ path: path.join(captureRoot, `${name}-${size.width}.png`), animations: "disabled" });
    };
    await capture("first-run");
    await page.getByRole("button", { name: "Continue with Steam" }).click();
    await expect(page.getByText("ABCD-1234", { exact: true })).toBeVisible();
    await capture("steam-sign-in");
    await page.evaluate(() => {
      const s = (window as any).fixture;
      s.status.paired = true;
      s.status.session.pairing = false;
      s.player.onboardingRequired = true;
    });
    await refresh(page);
    await expect(page.getByLabel("B2G player name")).toBeVisible();
    await capture("first-profile");
    await page.evaluate(() => { (window as any).fixture.status.paired = false; });
    await refresh(page);
    await navigate(page, "Settings");
    await expect(page.getByRole("heading", { name: "Launcher preferences" })).toBeVisible();
    await capture("signed-out-settings");
  });
}
