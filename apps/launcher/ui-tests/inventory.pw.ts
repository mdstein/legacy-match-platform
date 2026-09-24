import { test, expect, type Page } from "@playwright/test";
import { fixture, refresh } from "./fixture";
import { mkdir } from "node:fs/promises";
const navigate = (page: Page, name: string) => page.getByRole("navigation", { name: "Launcher" }).getByRole("button", { name, exact: true }).click();

test("initial inventory failure stops loading and Retry recovers the items", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { (window as any).fixture.errors.inventory = "Inventory is temporarily unavailable."; });
  await navigate(page, "Inventory");
  await expect(page.getByRole("alert")).toContainText("Inventory is temporarily unavailable.");
  await expect(page.getByText("Loading your inventory", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Your inventory is empty", { exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).fixture.errors.inventory = null; });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".inventory-item")).toHaveCount(3);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("inventory refresh retains cards, preserves search and shows Steam cooldown", async ({ page }) => {
  await fixture(page);
  await navigate(page, "Inventory");
  await expect(page.locator(".inventory-item")).toHaveCount(3);
  await page.getByRole("combobox", { name: "Item source" }).selectOption("steam");
  await page.getByRole("textbox", { name: "Search inventory" }).fill("Karambit");
  await expect(page.locator(".inventory-item")).toHaveCount(1);
  await page.evaluate(() => {
    const w = window as any;
    w.keptInventoryCard = document.querySelector(".inventory-item");
    w.fixture.delays.inventory_refresh = 500;
  });
  await page.getByRole("button", { name: "Refresh Steam inventory" }).click();
  await expect(page.getByRole("button", { name: "Refreshing Steam" })).toBeDisabled();
  await expect(page.locator(".inventory-item")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Steam refreshed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh Steam inventory" })).toBeDisabled();
  await expect(page.locator("#inventory-sync")).toContainText("Refresh available in");
  expect(await page.evaluate(() => (window as any).fixture.calls.filter((c: any) => c.op === "inventory_refresh").length)).toBe(1);
  expect(await page.evaluate(() => (window as any).keptInventoryCard === document.querySelector(".inventory-item"))).toBe(true);
  await navigate(page, "Trading");
  await navigate(page, "Inventory");
  await expect(page.getByRole("textbox", { name: "Search inventory" })).toHaveValue("Karambit");
});

test("Steam failures retain saved items and a short cooldown expires without reloading", async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const f = (window as any).fixture; f.inventory.nextRefreshAt = new Date(Date.now() + 1500).toISOString(); });
  await navigate(page, "Inventory");
  const button = page.getByRole("button", { name: "Refresh Steam inventory" });
  await expect(button).toBeDisabled();
  await expect(button).toBeEnabled({ timeout: 4500 });
  await page.evaluate(() => { (window as any).fixture.errors.inventory_refresh = "Steam inventory could not be verified. Your saved loadout was not changed."; });
  await button.click();
  await expect(page.getByRole("alert")).toContainText("Steam inventory could not be verified");
  await expect(page.locator(".inventory-item")).toHaveCount(3);
  await expect(button).toBeEnabled();
  await page.evaluate(() => { const f = (window as any).fixture; f.errors.inventory_refresh = null; f.inventory.status = "private"; });
  await button.click();
  await expect(page.locator(".inventory-page .notice")).toContainText("Your Steam inventory is private");
  await expect(page.locator(".inventory-item")).toHaveCount(3);
});

test("signing out hides inventory and discards an old account's delayed response", async ({ page }) => {
  await fixture(page);
  await navigate(page, "Inventory");
  await expect(page.locator(".inventory-item")).toHaveCount(3);
  await page.evaluate(() => { (window as any).fixture.delays.inventory = 1000; });
  await refresh(page);
  await navigate(page, "Settings");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Sign out", exact: true }).click();
  await navigate(page, "Inventory");
  await expect(page.getByText("Connect your B2G account", { exact: true })).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(page.locator(".inventory-item")).toHaveCount(0);
});

for (const width of [1360, 960]) test(`inventory details and filtering fit ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 960 ? 640 : 820 });
  await fixture(page);
  await navigate(page, "Inventory");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByRole("button", { name: "Refresh Steam inventory" })).toBeEnabled();
  await expect(page.locator(".inventory-art img")).toHaveCount(3);
  const searchIcon = await page.locator(".owned-inventory-search svg").boundingBox();
  const searchInput = await page.getByRole("textbox", { name: "Search inventory" }).boundingBox();
  expect(Math.abs(searchIcon!.y + searchIcon!.height / 2 - searchInput!.y - searchInput!.height / 2)).toBeLessThan(2);
  await expect.poll(() => page.locator(".inventory-art img").evaluateAll((images) => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await mkdir(".impeccable/review/inventory", { recursive: true });
  await page.screenshot({ path: `.impeccable/review/inventory/inventory-${width}.png`, animations: "disabled" });
  await page.getByRole("button", { name: "View ★ Karambit | Gamma Doppler", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("572");
  await expect(page.getByRole("dialog")).toContainText("205");
  await expect(page.getByRole("dialog")).toContainText("0.02451576478779316");
  await page.screenshot({ path: `.impeccable/review/inventory/details-${width}.png`, animations: "disabled" });
  const overflow = await page.getByRole("dialog").evaluate(el => el.scrollWidth > el.clientWidth + 1);
  expect(overflow).toBe(false);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "View ★ Karambit | Gamma Doppler", exact: true })).toBeFocused();
  await page.getByRole("combobox", { name: "Item source" }).selectOption("b2g");
  await expect(page.locator(".inventory-item")).toHaveCount(1);
});
