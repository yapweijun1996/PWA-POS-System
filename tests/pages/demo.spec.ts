import { test, expect } from "@playwright/test";
test("Pages subpath: canonical checkout, isolated storage, inventory and receipt survive offline reload without an API", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  const serverRequests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/\/(api|health)\//.test(new URL(r.url()).pathname))
      serverRequests.push(r.url());
  });
  await page.goto("./");
  await expect(
    page.getByRole("heading", { name: "Sell", exact: true }),
  ).toBeVisible();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  expect(
    await page
      .locator("img")
      .evaluateAll((images) =>
        images.every(
          (i) =>
            (i as HTMLImageElement).complete &&
            (i as HTMLImageElement).naturalWidth > 0,
        ),
      ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Add Cold Brew", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add Cold Brew", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add Oat Cookies", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add Sparkling Water", exact: true })
    .click();
  await page.getByRole("button", { name: /Take payment/ }).click();
  await page.getByLabel("Cash received", { exact: true }).fill("20.00");
  await page.getByRole("button", { name: "Simulate cash sale" }).click();
  await expect(page.getByRole("dialog")).toContainText("S$14.00");
  await expect(page.getByRole("dialog")).toContainText("S$6.00");
  await expect(page.getByRole("dialog")).toContainText("SIMULATION ONLY");
  const before = await page.evaluate(() =>
    Object.fromEntries(Object.entries(localStorage)),
  );
  await page.getByRole("button", { name: "New sale", exact: true }).click();
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "Cold Brew" }),
  ).toContainText("22");
  await page.getByRole("button", { name: "Sales", exact: true }).click();
  await expect(
    page.getByText("1 simulated receipts", { exact: false }),
  ).toBeVisible();
  await context.setOffline(true);
  const response = await page.reload();
  expect(response?.status()).toBe(200);
  expect(response?.fromServiceWorker()).toBe(true);
  await expect(
    page.getByRole("heading", { name: "Sell", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Object.fromEntries(Object.entries(localStorage))),
  ).toEqual(before);
  await page.getByRole("button", { name: "Sales", exact: true }).click();
  await expect(
    page.getByText("1 simulated receipts", { exact: false }),
  ).toBeVisible();
  expect(serverRequests).toEqual([]);
  expect(errors).toEqual([]);
});
test("Pages mobile: search, payment validation and explicit demo reset", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("./");
  await page.getByLabel("Search products", { exact: true }).fill("Cold Brew");
  await expect(page.getByRole("button", { name: /^Add / })).toHaveCount(1);
  await page
    .getByRole("button", { name: "Add Cold Brew", exact: true })
    .click();
  await page.getByRole("button", { name: /Take payment/ }).click();
  await page.getByLabel("Cash received", { exact: true }).fill("1.00");
  await expect(
    page.getByRole("button", { name: "Simulate cash sale" }),
  ).toBeDisabled();
  await page.getByLabel("Cash received", { exact: true }).fill("5.00");
  await page.getByRole("button", { name: "Simulate cash sale" }).click();
  await expect(page.getByRole("dialog")).toContainText("S$0.50");
  await page.getByRole("button", { name: "New sale", exact: true }).click();
  await page.getByRole("button", { name: "Reset demo", exact: true }).click();
  await page.getByRole("button", { name: "Reset sample data" }).click();
  await page.getByRole("button", { name: "Sales", exact: true }).click();
  await expect(
    page.getByText("No demo sales yet.", { exact: false }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.mouse.move(0, 0);
  await expect(
    page.getByRole("button", { name: "Sales", exact: true }),
  ).toHaveCSS("background-color", "rgb(11, 110, 97)");
  await page.screenshot({ path: "docs/qa/screenshots/pages-mobile.png" });
});
