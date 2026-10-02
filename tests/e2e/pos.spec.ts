import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
async function ready(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Enter manager demo" }).click();
  await expect(
    page.getByRole("heading", { name: "Sell", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add Cold Brew" }),
  ).toBeEnabled();
  const open = page.getByRole("button", { name: "Open shift", exact: true });
  if (await open.isVisible()) {
    await open.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Open shift", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await expect(
    page.getByRole("button", { name: "Add Cold Brew" }),
  ).toBeEnabled();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await expect
    .poll(() =>
      page
        .locator("img")
        .evaluateAll((images) =>
          images.every(
            (image) =>
              (image as HTMLImageElement).complete &&
              (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
    )
    .toBe(true);
}
async function basket(page: Page) {
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
}
async function checkout(page: Page) {
  await page.getByRole("button", { name: /Take payment/ }).click();
  await page
    .getByRole("textbox", { name: "Cash received", exact: true })
    .fill("20.00");
  await page.getByRole("button", { name: "Confirm cash received" }).click();
  await expect(
    page.getByRole("dialog").getByText("Synced", { exact: true }),
  ).toBeVisible();
}
async function stores(page: Page) {
  return page.evaluate(async () => {
    const req = indexedDB.open("counter-pos-v1");
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const result: Record<string, number> = {};
    for (const name of ["sales", "lines", "payments", "deltas", "outbox"]) {
      result[name] = await new Promise((resolve, reject) => {
        const r = db.transaction(name).objectStore(name).count();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    db.close();
    return result;
  });
}
test("T01/T02/T20 canonical cash and reprint preserve one sale", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await basket(page);
  await checkout(page);
  await expect(
    page.getByRole("dialog").getByText("S$6.00", { exact: true }),
  ).toBeVisible();
  const before = await stores(page);
  expect(before).toMatchObject({
    sales: 1,
    payments: 1,
    lines: 3,
    outbox: 1,
    deltas: 0,
  });
  await page.evaluate(() => {
    window.print = () => {};
  });
  await page.getByRole("button", { name: "Print receipt" }).click();
  await page.getByRole("button", { name: "Print receipt" }).click();
  expect(await stores(page)).toEqual(before);
  expect(errors).toEqual([]);
  await mkdir("docs/qa/screenshots", { recursive: true });
  await page.screenshot({ path: "docs/qa/screenshots/receipt.png" });
});
test("T05/T16/T17/T26 offline local commit survives reload and foreground ACK removes delta once", async ({
  page,
  context,
}) => {
  await ready(page);
  await context.setOffline(true);
  await expect(
    page.getByRole("button", { name: "Open sync center" }),
  ).toContainText("Offline");
  await basket(page);
  await page.getByRole("button", { name: /Take payment/ }).click();
  await expect(
    page.getByRole("button", { name: "Card", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "PayNow", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Cash received", exact: true })
    .fill("20.00");
  await page.getByRole("button", { name: "Confirm cash received" }).click();
  await expect(
    page.getByText("Saved on this device — waiting to sync"),
  ).toBeVisible();
  expect(await stores(page)).toMatchObject({
    sales: 1,
    payments: 1,
    lines: 3,
    outbox: 1,
    deltas: 3,
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Add Cold Brew" })).toBeEnabled(
    { timeout: 15000 },
  );
  await expect(
    page.getByRole("heading", { name: "Sell", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sales", exact: true }).click();
  await expect(page.getByText("PENDING", { exact: true })).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Sync center", exact: true }).click();
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText("ACKED", { exact: true })).toBeVisible();
  expect((await stores(page)).deltas).toBe(0);
});
test("T06 IndexedDB quota abort preserves cart with zero partial records", async ({
  page,
}) => {
  await ready(page);
  await basket(page);
  await page.getByRole("button", { name: /Take payment/ }).click();
  await page
    .getByRole("textbox", { name: "Cash received", exact: true })
    .fill("20.00");
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (
      ...args: Parameters<IDBObjectStore["add"]>
    ) {
      if (this.name === "sales") {
        IDBObjectStore.prototype.add = original;
        throw new DOMException(
          "Injected quota exhaustion",
          "QuotaExceededError",
        );
      }
      return original.apply(this, args);
    };
  });
  await page.getByRole("button", { name: "Confirm cash received" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Sale not saved",
  );
  expect(await stores(page)).toEqual({
    sales: 0,
    payments: 0,
    lines: 0,
    deltas: 0,
    outbox: 0,
  });
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(
    page.getByLabel("Current order").getByText("Cold Brew", { exact: true }),
  ).toBeVisible();
});
test("T15 second tab is read-only and takes ownership after lease expiry", async ({
  page,
  context,
}) => {
  await ready(page);
  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByText(/Read-only tab/)).toBeVisible();
  await expect(
    second.getByRole("button", { name: "Add Cold Brew" }),
  ).toBeDisabled();
  await page.close();
  await expect(
    second.getByRole("button", { name: "Add Cold Brew" }),
  ).toBeEnabled({ timeout: 15000 });
  await second.close();
});
test("T14 real N→N+1 waiting worker preserves pending records and updates safely", async ({
  page,
  context,
}) => {
  const original = await readFile("dist/web/sw.js", "utf8");
  try {
    await ready(page);
    await context.setOffline(true);
    await basket(page);
    await page.getByRole("button", { name: /Take payment/ }).click();
    await page
      .getByRole("textbox", { name: "Cash received", exact: true })
      .fill("20.00");
    await page.getByRole("button", { name: "Confirm cash received" }).click();
    await page.getByRole("button", { name: "New sale" }).click();
    const before = await stores(page);
    await writeFile(
      "dist/web/sw.js",
      original.replace(
        /counter-shell-[a-f0-9]+/g,
        "counter-shell-test-upgrade",
      ) + "\n// genuine N+1 test build\n",
    );
    await context.setOffline(false);
    await page.route("**/api/v1/sales", (route) => route.abort());
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update();
    });
    await expect(
      page.getByText("New version available", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Update now" }),
    ).toBeDisabled();
    expect(await stores(page)).toMatchObject({
      sales: before.sales,
      outbox: before.outbox,
    });
    await page.unroute("**/api/v1/sales");
    await page
      .getByRole("button", { name: "Sync center", exact: true })
      .click();
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText("ACKED", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Update now" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Update now" }).click();
    await expect(
      page.getByRole("heading", { name: "Sell", exact: true }),
    ).toBeVisible();
    expect((await stores(page)).sales).toBe(before.sales);
  } finally {
    await writeFile("dist/web/sw.js", original);
  }
});
test("T18 fresh offline launch gives an honest unavailable browser state", async ({
  context,
}) => {
  await context.setOffline(true);
  const page = await context.newPage();
  await expect(page.goto("/")).rejects.toThrow();
  await context.setOffline(false);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Enter manager demo" }),
  ).toBeVisible();
});
for (const viewport of [
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
])
  test(`T23 responsive ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await ready(page);
    await page.screenshot({
      path: `docs/qa/screenshots/sell-${viewport.width}.png`,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Add Cold Brew" }).click();
    if (viewport.width < 768)
      await page.getByRole("button", { name: /View order/ }).click();
    await page
      .getByRole("button", { name: /Take payment/ })
      .last()
      .click();
    await expect(
      page.getByRole("button", { name: "Confirm cash received" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
test("T21/T24 barcode search and dialog keyboard focus", async ({ page }) => {
  await ready(page);
  await page
    .getByRole("textbox", { name: "Search products", exact: true })
    .fill("DRK-001");
  await page
    .getByRole("textbox", { name: "Search products", exact: true })
    .press("Enter");
  await page.getByRole("button", { name: /Take payment/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Cash received", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /Take payment/ }),
  ).toBeFocused();
});
test("T32 expired session preserves AUTH_REQUIRED and resumes the same sale after sign-in", async ({
  page,
  context,
}) => {
  await ready(page);
  await context.setOffline(true);
  await expect(
    page.getByRole("button", { name: "Open sync center" }),
  ).toContainText("Offline");
  await basket(page);
  await page.getByRole("button", { name: /Take payment/ }).click();
  await page
    .getByRole("textbox", { name: "Cash received", exact: true })
    .fill("20.00");
  await page.getByRole("button", { name: "Confirm cash received" }).click();
  await page.getByRole("button", { name: "New sale" }).click();
  const before = await stores(page);
  await context.clearCookies();
  await context.setOffline(false);
  await expect(
    page.getByRole("button", { name: "Enter manager demo" }),
  ).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Enter manager demo" }).click();
  await page.getByRole("button", { name: "Sync center", exact: true }).click();
  await expect(page.getByText("ACKED", { exact: true })).toBeVisible();
  expect((await stores(page)).sales).toBe(before.sales);
});
test("FR02/03/07/12 back-office product, stock, refund and encrypted recovery roundtrip", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "Products", exact: true }).click();
  await page.getByRole("button", { name: "New product", exact: false }).click();
  await page
    .getByLabel("Product name", { exact: true })
    .fill("Synthetic Paper Cups");
  await page.getByLabel("SKU", { exact: true }).fill("CUP-TEST");
  await page.getByLabel("Price (SGD)", { exact: true }).fill("2.00");
  await page.getByLabel("Cost (SGD)", { exact: true }).fill("0.50");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  const item = page
    .locator(".stock-card")
    .filter({ hasText: "Synthetic Paper Cups" });
  await item.getByRole("button", { name: "Receive", exact: true }).click();
  await page.getByLabel("Units received").fill("8");
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Synthetic purchase receipt");
  await page.getByRole("button", { name: "Post movement" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Sell", exact: true }).click();
  await page.getByRole("button", { name: "Add Synthetic Paper Cups" }).click();
  await checkout(page);
  await page.getByRole("button", { name: "New sale" }).click();
  await page.getByRole("button", { name: "Sales", exact: true }).click();
  await page
    .locator("tbody tr")
    .first()
    .getByRole("button", { name: "View", exact: true })
    .click();
  await page.getByRole("button", { name: "Return items" }).click();
  await page.getByLabel(/Return quantity/).fill("1");
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Synthetic resalable return");
  await page.getByRole("button", { name: "Confirm return" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Sync center", exact: true }).click();
  await page
    .getByRole("button", { name: "Export recovery", exact: true })
    .click();
  await page
    .getByLabel(/Encryption passphrase/)
    .fill("synthetic-test-passphrase-only");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export encrypted package" }).click();
  const result = await download;
  const file = await result.path();
  expect(file).not.toBeNull();
  await page
    .getByRole("button", { name: "Restore recovery", exact: true })
    .click();
  await page.getByLabel("Encrypted recovery file").setInputFiles(file!);
  await page
    .getByLabel("Recovery passphrase", { exact: true })
    .fill("synthetic-test-passphrase-only");
  await page.getByRole("button", { name: "Validate & restore" }).click();
  await expect(page.getByText(/documents validated/)).toBeVisible();
  expect((await stores(page)).sales).toBe(1);
});
test("T23 mobile safe-area, long names and 200% equivalent reflow retain payment controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await page.route("**/qa-safe-area.css", (route) =>
    route.fulfill({
      contentType: "text/css",
      body: ".topbar{padding-top:63px}.mobile-order{padding-bottom:46px}",
    }),
  );
  await page.addStyleTag({ url: "/qa-safe-area.css" });
  await page
    .locator(".product h3")
    .first()
    .evaluate((element) => {
      element.textContent =
        "Synthetic extra long product name for responsive validation with a large package description and repeated length to exercise line wrapping near the text limit";
    });
  expect(
    await page
      .locator(".topbar")
      .evaluate((e) => getComputedStyle(e).paddingTop),
  ).toBe("63px");
  await page.getByRole("button", { name: "Add Cold Brew" }).click();
  await page.getByRole("button", { name: /View order/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Take payment/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm cash received" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.setViewportSize({ width: 720, height: 450 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("FR04 500-product cached catalogue benchmark", async ({ page }) => {
  const { database } = await import("../../apps/api/src/db.ts");
  const { randomUUID } = await import("node:crypto");
  const url =
    process.env.TEST_DATABASE_URL ??
    "postgresql://counter_pos_owner@127.0.0.1:55432/counter_pos_test";
  expect(new URL(url).pathname).toBe("/counter_pos_test");
  const pool = database(url);
  try {
    await pool.query("BEGIN");
    const category = (
      await pool.query(
        "SELECT store_id,id FROM categories ORDER BY name LIMIT 1",
      )
    ).rows[0];
    const actor = (
      await pool.query(
        "SELECT id FROM users WHERE store_id=$1 AND role='MANAGER'",
        [category.store_id],
      )
    ).rows[0].id;
    const existing = Number(
      (await pool.query("SELECT count(*) FROM products")).rows[0].count,
    );
    const version = (
      await pool.query(
        "UPDATE stores SET catalogue_version=catalogue_version+1 WHERE id=$1 RETURNING catalogue_version",
        [category.store_id],
      )
    ).rows[0].catalogue_version;
    for (let i = 0; i < 500 - existing; i++) {
      const id = randomUUID(),
        sku = "BENCH-" + String(i).padStart(4, "0"),
        name = "Benchmark item " + String(i).padStart(4, "0");
      await pool.query(
        "INSERT INTO products(id,store_id,category_id,sku,name) VALUES($1,$2,$3,$4,$5)",
        [id, category.store_id, category.id, sku, name],
      );
      await pool.query(
        "INSERT INTO product_prices(id,store_id,product_id,catalogue_version,unit_price_minor,created_by,name_snapshot,sku_snapshot) VALUES($1,$2,$3,$4,100,$5,$6,$7)",
        [randomUUID(), category.store_id, id, version, actor, name, sku],
      );
      await pool.query(
        "INSERT INTO stock_balances(store_id,product_id,quantity) VALUES($1,$2,50)",
        [category.store_id, id],
      );
      await pool.query(
        "INSERT INTO stock_movements(id,store_id,product_id,movement_type,quantity_delta,admin_event_id,reference,reason,actor_id) VALUES($1,$2,$3,'RECEIPT',50,$4,'Benchmark fixture','Synthetic opening quantity',$5)",
        [randomUUID(), category.store_id, id, randomUUID(), actor],
      );
    }
    await pool.query("COMMIT");
  } finally {
    await pool.end();
  }
  await ready(page);
  await expect(page.locator(".countline")).toContainText("500 products");
  const timings = await page.evaluate(async () => {
    const button = document.querySelector<HTMLButtonElement>(
      '[aria-label="Add Benchmark item 0000"]',
    )!;
    const samples: number[] = [];
    for (let i = 1; i <= 30; i++) {
      const start = performance.now();
      button.click();
      await new Promise<void>((resolve) => {
        const check = () => {
          if (
            document
              .querySelector(".order-heading p")
              ?.textContent?.includes(`· ${i} items`)
          )
            resolve();
          else requestAnimationFrame(check);
        };
        check();
      });
      samples.push(performance.now() - start);
    }
    const search = document.querySelector<HTMLInputElement>(
      '[aria-label="Search products"]',
    )!;
    const searchSamples: number[] = [];
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    for (let i = 0; i < 30; i++) {
      const query = String(i).padStart(4, "0"),
        start = performance.now();
      setter.call(search, query);
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise<void>((resolve) => {
        const check = () => {
          if (
            document.querySelector(".product h3")?.textContent?.endsWith(query)
          )
            resolve();
          else requestAnimationFrame(check);
        };
        check();
      });
      searchSamples.push(performance.now() - start);
    }
    return {
      add: samples,
      search: searchSamples,
      user_agent: navigator.userAgent,
    };
  });
  const percentile = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  const result = {
    dataset: 500,
    samples: 30,
    add_p95_ms: percentile(timings.add),
    search_p95_ms: percentile(timings.search),
    environment: timings.user_agent,
    measurement:
      "DOM update observed with performance.now; warm browser, synthetic products, no throttling",
  };
  expect(result.add_p95_ms).toBeLessThan(100);
  expect(result.search_p95_ms).toBeLessThan(150);
  await writeFile(
    "docs/qa/performance-results.json",
    JSON.stringify(result, null, 2),
  );
});

test("Uncertain cash movement is retained across reload and retries once", async ({
  page,
}) => {
  await ready(page);
  const { database } = await import("../../apps/api/src/db.ts");
  const url =
    process.env.TEST_DATABASE_URL ??
    "postgresql://counter_pos_owner@127.0.0.1:55432/counter_pos_test";
  expect(new URL(url).pathname).toBe("/counter_pos_test");
  const pool = database(url);
  try {
    const before = Number(
      (await pool.query("SELECT count(*) FROM cash_movements")).rows[0].count,
    );
    await page
      .getByRole("button", { name: "Close shift", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Cash in / out", exact: true })
      .click();
    await page.getByLabel("Amount (SGD)", { exact: true }).fill("5.00");
    await page
      .getByLabel("Reason", { exact: true })
      .fill("Synthetic uncertain cash response");
    await page.route(
      "**/cash-movements",
      async (route) => {
        await route.fetch();
        await route.abort("failed");
      },
      { times: 1 },
    );
    await page
      .getByRole("button", { name: "Record cash movement", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("Server unavailable");
    expect(
      Number(
        (await pool.query("SELECT count(*) FROM cash_movements")).rows[0].count,
      ),
    ).toBe(before + 1);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Sell", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close shift", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Reconcile & close shift",
        exact: true,
      }),
    ).toBeDisabled();
    await page.getByLabel("Actual cash (SGD)", { exact: true }).fill("100.00");
    await expect(
      page.getByRole("button", {
        name: "Reconcile & close shift",
        exact: true,
      }),
    ).toBeEnabled({ timeout: 15000 });
    await page
      .getByRole("button", { name: "Reconcile & close shift", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "saved request needs confirmation",
    );
    await page
      .getByRole("button", { name: "Sync center", exact: true })
      .click();
    await expect(
      page.getByText("Saved cash request", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Retry saved cash request", exact: true })
      .click();
    await expect(
      page.getByText("Saved cash request", { exact: true }),
    ).toHaveCount(0);
    expect(
      Number(
        (await pool.query("SELECT count(*) FROM cash_movements")).rows[0].count,
      ),
    ).toBe(before + 1);
  } finally {
    await pool.end();
  }
});

test("T07/T11 price changes require another payment review and archived receipts retain snapshots", async ({
  page,
}) => {
  await ready(page);
  await page
    .getByRole("button", { name: "Add Cold Brew", exact: true })
    .click();
  await page.getByRole("button", { name: "Products", exact: true }).click();
  const row = page.locator("tbody tr").filter({ hasText: "DRK-001" });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Price (SGD)", { exact: true }).fill("5.00");
  await page.getByRole("button", { name: "Save product", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Sell", exact: true }).click();
  await page.getByRole("button", { name: /Take payment/ }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Prices changed. Review the updated order",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: /Take payment/ }).click();
  await page.getByLabel("Cash received", { exact: true }).fill("5.00");
  await page
    .getByRole("button", { name: "Confirm cash received", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByText("Synced", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New sale", exact: true }).click();
  await page.getByRole("button", { name: "Products", exact: true }).click();
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByLabel("Product name", { exact: true })
    .fill("Renamed archived cold brew");
  await page.getByLabel("Price (SGD)", { exact: true }).fill("6.00");
  await page.getByLabel("Active product", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Save product", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Sales", exact: true }).click();
  await page
    .locator("tbody tr")
    .first()
    .getByRole("button", { name: "View", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByText(/Cold Brew/)).toBeVisible();
  await expect(
    page.getByRole("dialog").getByText(/Renamed archived cold brew/),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog")).toContainText("S$5.00");
});
