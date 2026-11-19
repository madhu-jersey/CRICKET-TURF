import { test, expect } from "@playwright/test";
import { bookThroughReview } from "./helpers";

test("happy path: home → one-page booking with new-customer offer → OTP → pay → confirmation", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.getByText("Demo: payments and messages are simulated")).toBeVisible();
  await page.getByRole("link", { name: "Book cricket" }).first().click();
  await expect(page).toHaveURL(/\/book\?sport=cricket/);

  const { code } = await bookThroughReview(page, info, { dateIndex: 2, hours: 2 });
  await expect(page.getByText(/\(2 hr\)/)).toBeVisible();
  await page.getByTestId("mock-success").click();

  await expect(page).toHaveURL(new RegExp(`/booking/${code}`));
  await expect(page.getByRole("heading", { name: "You're booked!" })).toBeVisible();
  await expect(page.getByTestId("booking-status")).toHaveText("Confirmed");
  await expect(page.getByText(/You saved ₹\d+ \(first booking\)/)).toBeVisible();
  await expect(page.getByRole("img", { name: new RegExp(`QR code for booking ${code}`) })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add to Google Calendar" })).toHaveAttribute("href", /calendar\.google\.com/);
});

test("payment failure → retry → success", async ({ page }, info) => {
  const { code } = await bookThroughReview(page, info, { dateIndex: 3, sport: "pickleball" });
  await page.getByTestId("mock-failure").click();
  await expect(page.getByRole("alertdialog", { name: "Payment failed" })).toBeVisible();
  await expect(page.getByText(/your slot is still kept/i)).toBeVisible();
  await page.getByTestId("retry-payment").click();
  await page.getByTestId("mock-success").click();
  await expect(page).toHaveURL(new RegExp(`/booking/${code}`));
  await expect(page.getByTestId("booking-status")).toHaveText("Confirmed");
});

test("cancel with refund (more than 2 hours ahead)", async ({ page }, info) => {
  const { code } = await bookThroughReview(page, info, { dateIndex: 9 });
  await page.getByTestId("mock-success").click();
  await expect(page.getByTestId("booking-status")).toHaveText("Confirmed");

  await expect(page.getByText("Cancel now and get ₹300 back.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel booking" }).click();
  // Money back needs a new code, even though this phone was just verified on this device. [SEC-43]
  await expect(page.getByText("To send your refund, confirm it's you with a new code.")).toBeVisible();
  const otp = (await page.getByTestId("dev-otp-code").textContent())!.trim();
  await page.getByLabel("Digit 1").fill(otp);
  await page.getByTestId("confirm-cancel").click();
  await expect(page.getByText(/₹300 will be refunded/)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("booking-status")).toHaveText("Cancelled · refunded");
  await expect(page.getByTestId("booking-code")).toHaveText(code);
});

test("slot that is already held shows as booked to others", async ({ page, browser }, info) => {
  const { code, time } = await bookThroughReview(page, info, { dateIndex: 4 });
  expect(code).toMatch(/^BBA-/);
  // A second visitor sees the held slot as Booked.
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto("/book?sport=cricket");
  await p2.locator('section[aria-labelledby="h-date"] button').nth(4).click();
  await expect(p2.locator(`button[data-time="${time}"]`)).toHaveAttribute("data-state", "BOOKED");
  await other.close();
});

test("1 phone, 1 offer: a second number on the same phone gets no discount", async ({ page }, info) => {
  await bookThroughReview(page, info, { dateIndex: 5 }); // first number on this phone: offer applied
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Start again" }).click();
  // Same browser (same phone), different new mobile number.
  await page.goto("/book?sport=cricket");
  await page.getByLabel("Mobile number").fill(`9${info.project.name === "mobile" ? 6 : 5}${String(Date.now()).slice(-8)}`);
  await page.getByTestId("verify-phone").click();
  const code = (await page.getByTestId("dev-otp-code").textContent())!.trim();
  await page.getByLabel("Digit 1").fill(code);
  await expect(page.getByTestId("phone-verified")).toBeVisible();
  await expect(page.getByTestId("offer-not-eligible")).toContainText("already been used on this phone");
  await expect(page.getByTestId("offer-applied")).toHaveCount(0);
});
