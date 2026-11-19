/**
 * Admin pages used at the ground — schedule, walk-in, bookings list, settings — on BOTH the desktop and
 * the mobile (Pixel 7) projects. On mobile each page is also checked for sideways scrolling and for tap
 * targets smaller than 44×44 px (the common minimum for a finger).
 */
import { test, expect, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { istDate } from "./helpers";

test.describe.configure({ mode: "serial" });

const TAP_MIN = 44;
let ctx: BrowserContext;
let page: Page;

/** One owner login per project: admin login is rate limited (5 per account per 15 min). */
async function loginOnce(browser: Browser, info: TestInfo) {
  const u = info.project.use;
  ctx = await browser.newContext({
    baseURL: u.baseURL,
    viewport: u.viewport,
    userAgent: u.userAgent,
    deviceScaleFactor: u.deviceScaleFactor,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
  });
  page = await ctx.newPage();
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill("owner@demo.com");
  await page.getByLabel("Password").fill("Demo@1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  const code = (await page.getByTestId("admin-dev-code").locator("strong").textContent())!.trim();
  await page.getByLabel("Login code").fill(code);
  await page.getByRole("button", { name: "Verify code" }).click();
  // First two-step login on this server shows the recovery codes once.
  const overview = page.getByRole("heading", { name: "Overview" });
  const codes = page.getByTestId("recovery-codes");
  await expect(overview.or(codes)).toBeVisible();
  if (await codes.isVisible()) {
    await page.getByTestId("recovery-saved").check();
    await page.getByTestId("recovery-continue").click();
  }
  await expect(overview).toBeVisible();
}

/** Sideways scrolling and too-small tap targets on the current page (mobile only). */
async function layoutProblems(p: Page) {
  return p.evaluate((min) => {
    const out: string[] = [];
    const vw = window.innerWidth;
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrolls sideways (${document.documentElement.scrollWidth}px wide, screen ${vw}px)`);
    const sel = "main button, main a[href], main input:not([type=hidden]), main select, main textarea, [role=dialog] button, [role=dialog] a[href], [role=dialog] input, [role=dialog] select, nav[aria-label='Quick navigation'] a, nav[aria-label='Quick navigation'] button";
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || st.visibility === "hidden" || st.display === "none") continue;
      // Links inside a sentence are exempt (WCAG 2.5.8 inline exception).
      if (el.tagName === "A" && st.display === "inline") continue;
      // A checkbox/radio counts as its whole label when the label is the tap target.
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        const lr = el.closest("label")?.getBoundingClientRect();
        if (lr && lr.height >= min) continue;
      }
      // Cells of a horizontally scrolling grid (the schedule) are checked for height only.
      const inScroller = !!el.closest("[data-scroll-grid]");
      if (r.height < min - 0.5 || (!inScroller && r.width < min - 0.5)) {
        const name = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("name") || el.id || "").replace(/\s+/g, " ").trim().slice(0, 40);
        out.push(`${el.tagName.toLowerCase()} "${name}" is ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
    }
    return [...new Set(out)];
  }, TAP_MIN);
}

async function checkLayout(info: TestInfo, where: string) {
  if (info.project.name !== "mobile") return;
  const problems = await layoutProblems(page);
  expect(problems, `${where} on mobile`).toEqual([]);
}

test.beforeAll(async ({ browser }, info) => {
  await loginOnce(browser, info);
});
test.afterAll(async () => {
  await ctx?.close();
});

test("schedule: day view loads, moves between days, and opens a booking", async ({}, info) => {
  await page.goto("/admin/schedule");
  await expect(page.getByRole("heading", { name: "Schedule" })).toBeVisible();
  await checkLayout(info, "schedule");
  await page.getByRole("button", { name: "Next day" }).click();
  await expect(page).toHaveURL(/date=/);
  await page.getByRole("button", { name: "Today" }).click();
  await expect(page).toHaveURL(new RegExp(`date=${istDate(0)}`));
  // Seed data has bookings today/tomorrow; open the first one we can find in the next few days.
  for (let i = 0; i < 4; i++) {
    const block = page.locator("[data-booking-id]").first();
    if (await block.count()) {
      await block.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await checkLayout(info, "schedule booking drawer");
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).first().click();
      return;
    }
    const url = page.url();
    await page.getByRole("button", { name: "Next day" }).click();
    await expect(page).not.toHaveURL(url);
  }
  throw new Error("no booking found on the schedule in the next 4 days");
});

test("walk-in: create a booking from the phone", async ({}, info) => {
  await page.goto("/admin/walk-in");
  await page.getByLabel("Date", { exact: true }).fill(istDate(info.project.name === "mobile" ? 4 : 3));
  await checkLayout(info, "walk-in");
  await page.locator('button[aria-pressed="false"]:not([disabled])[data-time]').first().click();
  await page.getByLabel("Customer name").fill(`Walk In ${info.project.name}`);
  await page.getByLabel("Mobile (10 digits)").fill(info.project.name === "mobile" ? "9123456771" : "9123456772");
  await page.getByLabel("Amount received (₹)").fill("500");
  await page.getByTestId("walkin-submit").click();
  await expect(page.getByText(/Booked BBA-/)).toBeVisible();
  await checkLayout(info, "walk-in after booking");
});

test("bookings list: search finds the walk-in and the drawer opens", async ({}, info) => {
  await page.goto("/admin/bookings");
  await checkLayout(info, "bookings list");
  await page.getByLabel("Search").fill(`Walk In ${info.project.name}`);
  await page.getByLabel("Search").press("Enter");
  await expect(page).toHaveURL(/q=/);
  const row = info.project.name === "mobile" ? page.locator("ul li button").filter({ hasText: `Walk In ${info.project.name}` }).first() : page.getByRole("button", { name: "Manage" }).first();
  await row.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("#drawer-title")).toHaveText(/BBA-/);
  await checkLayout(info, "booking drawer");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).first().click();
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("settings: change a value, save, and it sticks after reload", async ({}, info) => {
  await page.goto("/admin/settings");
  await checkLayout(info, "settings");
  const field = page.locator("#s-maxDaysAhead");
  const before = await field.inputValue();
  const next = before === "21" ? "20" : "21";
  await field.fill(next);
  await page.getByTestId("save-settings").click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
  await page.reload();
  await expect(page.locator("#s-maxDaysAhead")).toHaveValue(next);
  // Put it back so other tests see the seeded value.
  await page.locator("#s-maxDaysAhead").fill(before);
  await page.getByTestId("save-settings").click();
  await expect(page.getByText("Settings saved.")).toBeVisible();
});

// Owner pages used less often at the ground, but still on a phone. One test with soft checks so a
// run reports every page's problems at once. [SEC-63]
test("owner pages (overview, pricing, courts, gallery, team, audit, outbox, customers, blocked) load and pass the phone layout check", async ({}, info) => {
  for (const [path, heading] of [
    ["/admin", "Overview"],
    ["/admin/pricing", "Pricing"],
    ["/admin/courts", "Courts & hours"],
    ["/admin/gallery", "Gallery"],
    ["/admin/team", "Team"],
    ["/admin/audit", "Audit log"],
    ["/admin/messages", "Message outbox"],
    ["/admin/customers", "Customers"],
    ["/admin/blocked", "Blocked slots"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
    if (info.project.name === "mobile") expect.soft(await layoutProblems(page), `${heading} on mobile`).toEqual([]);
  }
});
