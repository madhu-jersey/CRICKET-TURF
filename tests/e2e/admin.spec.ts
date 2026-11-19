import { test, expect, type Page } from "@playwright/test";
import { istDate } from "./helpers";

test.skip(({ isMobile }) => isMobile, "Admin flow runs once, on desktop");

async function login(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill("owner@demo.com");
  await page.getByLabel("Password").fill("Demo@1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  // Two-factor step (the e2e server runs with ADMIN_2FA_REQUIRED=true; demo shows the code).
  const code = (await page.getByTestId("admin-dev-code").locator("strong").textContent())!.trim();
  await page.getByLabel("Login code").fill(code);
  await page.getByRole("button", { name: "Verify code" }).click();
  // The first two-step login on this server shows the recovery codes once. [SEC-41]
  const overview = page.getByRole("heading", { name: "Overview" });
  const codes = page.getByTestId("recovery-codes");
  await expect(overview.or(codes)).toBeVisible();
  if (await codes.isVisible()) {
    await expect(page.getByTestId("recovery-code")).toHaveCount(10);
    await page.getByTestId("recovery-saved").check();
    await page.getByTestId("recovery-continue").click();
  }
  await expect(overview).toBeVisible();
}

/** Next weekday (Mon–Fri), 1–13 days out, that isn't the seeded holiday at +6. */
function weekdayDate() {
  for (let d = 1; d < 14; d++) {
    if (d === 6) continue;
    const key = istDate(d);
    const dow = new Date(`${key}T12:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5) return { key, offset: d };
  }
  throw new Error("no weekday");
}

test("admin: login → walk-in → block slot → edit price → public grid shows it", async ({ page }) => {
  await login(page);

  // Walk-in booking for tomorrow on the cricket court.
  await page.goto("/admin/walk-in");
  await page.getByLabel("Date", { exact: true }).fill(istDate(1));
  await page.locator('button[aria-pressed="false"]:not([disabled])[data-time]').first().click();
  await page.getByLabel("Customer name").fill("Walk In Guest");
  await page.getByLabel("Mobile (10 digits)").fill("9123456780");
  await page.getByLabel("Amount received (₹)").fill("500");
  await page.getByTestId("walkin-submit").click();
  await expect(page.getByText(/Booked BBA-/)).toBeVisible();

  // Block 10–11 PM on Pickleball Court 2, two days out.
  await page.goto("/admin/blocked");
  await page.getByLabel("Court", { exact: true }).selectOption({ label: "Pickleball Court 2" });
  await page.getByLabel("Date", { exact: true }).fill(istDate(2));
  await page.getByLabel("Start time").fill("22:00");
  await page.getByLabel("End time").fill("23:00");
  await page.getByLabel("Note (optional)").fill("E2E block");
  await page.getByTestId("block-submit").click();
  await expect(page.getByText("Blocked 1 time slot.")).toBeVisible();
  await expect(page.getByText("E2E block").first()).toBeVisible();

  // Change cricket weekday day-rate to ₹777 (cricket is the first court; weekday is the default tab).
  await page.goto("/admin/pricing");
  await page.getByTestId("price-0").fill("777");
  await page.getByTestId("save-pricing").click();
  await expect(page.getByText(/Saved for/)).toBeVisible();

  // Public slot grid reflects the new price.
  const { key } = weekdayDate();
  await page.goto(`/book?sport=cricket&date=${key}`);
  await expect(page.locator('button[data-time="10:00"]')).toContainText("₹777");

  // And the pickleball block shows as closed for customers.
  await page.goto(`/book?sport=pickleball&date=${istDate(2)}`);
  await page.getByRole("button", { name: "Pickleball Court 2" }).click();
  await expect(page.locator('button[data-time="22:00"]')).toHaveAttribute("data-state", "BLOCKED");
});
