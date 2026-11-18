import { expect, type Page, type TestInfo } from "@playwright/test";

let phoneCounter = 0;
/** Distinct, valid Indian mobile per test/project so OTP rate limits never collide. */
export function testPhone(info: TestInfo) {
  phoneCounter++;
  const project = info.project.name === "mobile" ? 7 : 8;
  return `9${project}${String(info.workerIndex).padStart(2, "0")}${String(Date.now() % 100000).padStart(5, "0")}${phoneCounter % 10}`.slice(0, 10);
}

/** IST date key `days` from now. */
export function istDate(days: number) {
  const t = new Date(Date.now() + 330 * 60_000 + days * 86_400_000);
  return t.toISOString().slice(0, 10);
}

/** Fills the one-page booking form and holds the slot. Returns the booking code and slot time. */
export async function bookThroughReview(page: Page, info: TestInfo, opts: { dateIndex: number; sport?: "cricket" | "pickleball"; expectOffer?: boolean; hours?: number }) {
  await page.goto(`/book?sport=${opts.sport ?? "cricket"}`);
  await page.locator('section[aria-labelledby="h-date"] button').nth(opts.dateIndex).click();
  if (opts.hours) await page.getByTestId(`duration-${opts.hours}`).click();
  const slot = page.locator('button[data-fits="true"]').first();
  const time = (await slot.getAttribute("data-time"))!;
  await slot.click();
  await expect(slot).toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("Your name").fill("E2E Player");
  await page.getByLabel("Mobile number").fill(testPhone(info));
  await page.getByTestId("verify-phone").click();
  const code = (await page.getByTestId("dev-otp-code").textContent())!.trim();
  await page.getByLabel("Digit 1").fill(code); // paste-style fill of all 6 digits
  await expect(page.getByTestId("phone-verified")).toBeVisible();
  if (opts.expectOffer !== false) {
    await expect(page.getByTestId("offer-applied")).toBeVisible();
    await expect(page.getByTestId("discount-line")).toBeVisible();
  }

  await page.getByTestId("terms").check();
  await page.getByTestId("hold-button").click();
  await expect(page.getByTestId("hold-timer")).toBeVisible();
  // The payment window opens by itself after the slot is held (one tap for the customer).
  await expect(page.getByTestId("mock-success")).toBeVisible();
  return { code: (await page.getByTestId("hold-code").textContent())!.trim(), time };
}
