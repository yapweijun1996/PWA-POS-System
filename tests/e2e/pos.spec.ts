import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer, request } from "node:http";
async function ready(page: Page, productName = "Cold Brew", url = "/") {
  await page.goto(url);
  await page.getByRole("button", { name: "Enter manager demo" }).click();
  await expect(
    page.getByRole("heading", { name: "Sell", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add " + productName }),
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
    page.getByRole("button", { name: "Add " + productName }),
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
async function outageOrigin() {
  // Real transport unavailability avoids Playwright WebKit's setOffline/SW bug #42775.
  const upstreamOrigin = "http://localhost:3001";
  let port = 0;
  const origin = () => `http://localhost:${port}`;
  const server = createServer((incoming, outgoing) => {
    const headers = { ...incoming.headers, host: "localhost:3001" };
    // The isolated API fixture has a fixed CSRF origin; preserve its checks behind the proxy.
    if (headers.origin === origin()) headers.origin = upstreamOrigin;
    if (headers.referer?.startsWith(origin() + "/"))
      headers.referer = upstreamOrigin + headers.referer.slice(origin().length);
    const upstream = request(
      {
        hostname: "127.0.0.1",
        port: 3001,
        path: incoming.url,
        method: incoming.method,
        headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  async function start() {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Loopback proxy did not start");
    port = address.port;
  }
  async function stop() {
    if (!server.listening) return;
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
  }
  await start();
  return { origin: origin(), start, stop };
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
async function freshShift(page: Page, openNext = true) {
  // Previous isolated browser scenarios share the synthetic server fixture; finish that shift before this case.
  const closed = await page.evaluate(async () => {
    const boot = await fetch("/api/v1/bootstrap").then((r) => r.json());
    const headers = {
      "Content-Type": "application/json",
      "X-CSRF-Token": boot.csrf_token,
    };
    const current = await fetch("/api/v1/shifts/current").then((r) => r.json());
    const sales = (await fetch("/api/v1/sales?limit=100").then((r) =>
      r.json(),
    )) as { shift_id: string; client_sale_id: string }[];
    const ack = await fetch(`/api/v1/shifts/${current.id}/reconcile`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        device_id: current.device_id,
        sale_ids: sales
          .filter((s) => s.shift_id === current.id)
          .map((s) => s.client_sale_id),
        pending_count: 0,
      }),
    });
    if (!ack.ok) throw new Error("Prior synthetic shift reconciliation failed");
    return (
      await fetch(`/api/v1/shifts/${current.id}/close`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          counted_minor: current.expected_cash_minor,
          reason: "Close prior isolated browser fixtures",
          ...(await ack.json()),
        }),
      })
    ).status;
  });
  expect(closed).toBe(200);
  await page.getByRole("button", { name: "Sync center", exact: true }).click();
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  if (!openNext) return;
  await page.getByRole("button", { name: "Open shift", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Open shift", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
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
async function saleIdentities(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opened = indexedDB.open("counter-pos-v1");
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () => reject(opened.error);
    });
    try {
      const rows = await new Promise<{ id: string; hash: string }[]>(
        (resolve, reject) => {
          const read = db.transaction("outbox").objectStore("outbox").getAll();
          read.onsuccess = () => resolve(read.result);
          read.onerror = () => reject(read.error);
        },
      );
      return rows.map(({ id, hash }) => ({ id, hash }));
    } finally {
      db.close();
    }
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
  browserName,
}) => {
  const origin = browserName === "webkit" ? await outageOrigin() : null;
  try {
    await ready(page, "Cold Brew", origin?.origin ?? "/");
    const readyCache = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const cached = await caches.match("/");
      return {
        controlled: !!navigator.serviceWorker.controller,
        active: registration.active?.state,
        cached: cached?.status,
      };
    });
    expect(readyCache).toEqual({
      controlled: true,
      active: "activated",
      cached: 200,
    });
    if (origin) await origin.stop();
    else await context.setOffline(true);
    const unavailable = await page.evaluate(() =>
      fetch("/health/ready", { cache: "no-store" }).then(
        () => false,
        () => true,
      ),
    );
    expect(unavailable).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
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
    const documentBeforeReload = await page.evaluate(
      () => performance.timeOrigin,
    );
    const originalIdentity = await saleIdentities(page);
    const navigation = await page.reload();
    expect(navigation?.status()).toBe(200);
    expect(navigation?.fromServiceWorker()).toBe(true);
    expect(await page.evaluate(() => performance.timeOrigin)).toBeGreaterThan(
      documentBeforeReload,
    );
    await expect(
      page.getByRole("button", { name: "Add Cold Brew" }),
    ).toBeEnabled({ timeout: 15000 });
    await expect(
      page.getByRole("heading", { name: "Sell", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sales", exact: true }).click();
    await expect(page.getByText("PENDING", { exact: true })).toBeVisible();
    expect(await saleIdentities(page)).toEqual(originalIdentity);
    if (origin) await origin.start();
    else await context.setOffline(false);
    await page
      .getByRole("button", { name: "Sync center", exact: true })
      .click();
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText("ACKED", { exact: true })).toBeVisible();
    expect((await stores(page)).deltas).toBe(0);
  } finally {
    if (origin) await origin.stop();
    else await context.setOffline(false);
  }
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
    await page.getByRole("button", { name: "Sell", exact: true }).click();
    await page
      .getByRole("button", { name: "Add Cold Brew", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Update now" }),
    ).toBeDisabled();
    await page.screenshot({ path: "docs/qa/screenshots/update-desktop.png" });
    await page.getByRole("button", { name: /Take payment/ }).click();
    await expect(
      page.getByRole("button", { name: "Update now", includeHidden: true }),
    ).toBeDisabled();
    await expect(
      page.getByLabel("Cash received", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await page
      .getByRole("button", { name: "Clear draft", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Update now" }),
    ).toBeEnabled();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: "Add Cold Brew", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /View order · 1 items/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Update now" }),
    ).toBeDisabled();
    await page.screenshot({ path: "docs/qa/screenshots/update-mobile.png" });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: /View order/ }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /Take payment/ })
      .click();
    await expect(
      page.getByLabel("Cash received", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Update now", includeHidden: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: /View order/ }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await page.getByRole("button", { name: "Close dialog" }).click();
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
  await page
    .getByRole("textbox", { name: "Search products", exact: true })
    .fill("UNKNOWN-SYNTHETIC-999");
  await page
    .getByRole("textbox", { name: "Search products", exact: true })
    .press("Enter");
  await expect(page.getByRole("alert")).toContainText("Product not found");
  await expect(
    page.getByLabel("Current order").getByText("Cold Brew", { exact: true }),
  ).toBeVisible();
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
  await page.evaluate(() => {
    // Use the loaded same-origin stylesheet; SW-owned requests bypass routing on WebKit.
    const stylesheet = [...document.styleSheets].find((sheet) =>
      sheet.href?.includes("/assets/"),
    );
    if (!stylesheet) throw new Error("The application stylesheet is missing");
    stylesheet.insertRule(
      ".topbar{padding-top:63px}",
      stylesheet.cssRules.length,
    );
    stylesheet.insertRule(
      ".mobile-order{padding-bottom:46px}",
      stylesheet.cssRules.length,
    );
  });
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
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("saved requests");
    await page
      .getByRole("button", { name: "Export recovery", exact: true })
      .click();
    await page
      .getByLabel(/Encryption passphrase/)
      .fill("synthetic-command-recovery-only");
    const exported = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Export encrypted package" })
      .click();
    const file = await (await exported).path();
    expect(file).not.toBeNull();
    // Only this isolated browser fixture is cleared after a validated encrypted export exists.
    await page.evaluate(async () => {
      const request = indexedDB.open("counter-pos-v1");
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction("meta", "readwrite");
        transaction.objectStore("meta").delete("cash_command");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    });
    await page
      .getByRole("button", { name: "Restore recovery", exact: true })
      .click();
    await page.getByLabel("Encrypted recovery file").setInputFiles(file!);
    await page
      .getByLabel("Recovery passphrase", { exact: true })
      .fill("synthetic-command-recovery-only");
    await page.getByRole("button", { name: "Validate & restore" }).click();
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

test("T02 rapid confirmation stores exactly one local and server sale", async ({
  page,
}) => {
  await ready(page);
  await page
    .getByRole("button", { name: "Add Cold Brew", exact: true })
    .click();
  await page.getByRole("button", { name: /Take payment/ }).click();
  await page.getByLabel("Cash received", { exact: true }).fill("20.00");
  await page
    .getByRole("button", { name: "Confirm cash received" })
    .evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
  await expect(
    page.getByRole("dialog").getByText("Synced", { exact: true }),
  ).toBeVisible();
  expect(await stores(page)).toMatchObject({
    sales: 1,
    lines: 1,
    payments: 1,
    outbox: 1,
    deltas: 0,
  });
});

test("T26 multiple pending stock documents retain one projection across a lost acknowledgement", async ({
  page,
  context,
}) => {
  await ready(page);
  const button = page.getByRole("button", {
    name: "Add Cold Brew",
    exact: true,
  });
  const quantity = async () =>
    Number(
      (await button.locator(".product-foot small").innerText()).match(
        /(\d+) left/,
      )![1],
    );
  const original = await quantity();
  await context.setOffline(true);
  await expect(
    page.getByRole("button", { name: "Open sync center" }),
  ).toContainText("Offline");
  for (let n = 0; n < 2; n++) {
    await button.click();
    await page.getByRole("button", { name: /Take payment/ }).click();
    await page.getByLabel("Cash received", { exact: true }).fill("20.00");
    await page.getByRole("button", { name: "Confirm cash received" }).click();
    await expect(
      page.getByText("Saved on this device — waiting to sync"),
    ).toBeVisible();
    await page.getByRole("button", { name: "New sale", exact: true }).click();
  }
  const ids = await page.evaluate(async () => {
    const request = indexedDB.open("counter-pos-v1");
    const database = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const rows = await new Promise<{ id: string }[]>((resolve) => {
      const read = database
        .transaction("outbox")
        .objectStore("outbox")
        .getAll();
      read.onsuccess = () => resolve(read.result);
    });
    database.close();
    return rows.map((row) => row.id);
  });
  expect(ids).toHaveLength(2);
  expect(await quantity()).toBe(original - 2);
  await page.route("**/api/v1/sales", async (route) => {
    const body = route.request().postDataJSON() as { client_sale_id: string };
    if (body.client_sale_id === ids[0]) await route.fetch();
    await route.abort("failed");
  });
  await context.setOffline(false);
  await page.getByRole("button", { name: "Sync center", exact: true }).click();
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByText("RETRY", { exact: true })).toHaveCount(2);
  // Keep the fault installed until the entire manual drain and refresh finish.
  await expect(
    page.getByRole("button", { name: "Sync now", exact: true }),
  ).toBeEnabled();
  expect((await stores(page)).deltas).toBe(1);
  await page.getByRole("button", { name: "Sell", exact: true }).click();
  expect(await quantity()).toBe(original - 2);
  await page.unroute("**/api/v1/sales");
  await page.getByRole("button", { name: "Sync center", exact: true }).click();
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByText("ACKED", { exact: true })).toHaveCount(2);
  expect((await stores(page)).deltas).toBe(0);
  await page.getByRole("button", { name: "Sell", exact: true }).click();
  expect(await quantity()).toBe(original - 2);
});

test("T25 expired offline permit blocks checkout and preserves the unfinished order", async ({
  page,
  context,
}) => {
  await page.route("**/offline-permit", async (route) => {
    const response = await route.fetch(),
      value = await response.json();
    await route.fulfill({
      response,
      json: { ...value, expires_at: "2000-01-01T00:00:00.000Z" },
    });
  });
  await ready(page);
  await page
    .getByRole("button", { name: "Add Cold Brew", exact: true })
    .click();
  await context.setOffline(true);
  await expect(
    page.getByRole("button", { name: "Open sync center" }),
  ).toContainText("Offline");
  await page.getByRole("button", { name: /Take payment/ }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Offline authorization is unavailable",
  );
  expect((await stores(page)).sales).toBe(0);
  await expect(
    page.getByLabel("Current order").getByText("Cold Brew", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Hold or clear the current order",
  );
});

test("Production operator management and self-service password replacement work through Settings", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Operators", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New operator", exact: true }).click();
  await page
    .getByLabel("Operator name", { exact: true })
    .fill("Browser Test Operator");
  await page
    .getByLabel("Operator email", { exact: true })
    .fill("browser.operator@example.test");
  await page
    .getByLabel("Initial password (12+ characters)", { exact: true })
    .fill(crypto.randomUUID());
  await page
    .getByRole("button", { name: "Save operator", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const user = page
    .locator("tbody tr")
    .filter({ hasText: "browser.operator@example.test" });
  await expect(user).toContainText("CASHIER");
  await user
    .getByRole("button", { name: "Edit operator", exact: true })
    .click();
  await page
    .getByLabel("Operator name", { exact: true })
    .fill("Browser Test Manager");
  await page
    .getByLabel("Operator role", { exact: true })
    .selectOption("MANAGER");
  await page
    .getByLabel("Account change reason", { exact: true })
    .fill("Synthetic manager coverage");
  await page
    .getByRole("button", { name: "Save operator", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(user).toContainText("MANAGER");
  await user
    .getByRole("button", { name: "Reset password", exact: true })
    .click();
  await page
    .getByLabel("Initial password (12+ characters)", { exact: true })
    .fill(crypto.randomUUID());
  await page
    .getByLabel("Account change reason", { exact: true })
    .fill("Synthetic password reset");
  await page
    .getByRole("button", { name: "Reset operator password", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const credentials: { manager: string } = JSON.parse(
    await readFile(".local/test-users.json", "utf8"),
  );
  const temporary = crypto.randomUUID();
  for (const [current, replacement] of [
    [credentials.manager, temporary],
    [temporary, credentials.manager],
  ]) {
    await page
      .getByRole("button", { name: "Change my password", exact: true })
      .click();
    await page.getByLabel("Current password", { exact: true }).fill(current);
    await page
      .getByLabel("New password (12+ characters)", { exact: true })
      .fill(replacement);
    await page
      .getByRole("button", { name: "Change password", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Sell", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Operators", exact: true }),
    ).toBeVisible();
  }
});

test("T13 cash-count draft survives normal reload with its shift identity", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "Close shift", exact: true }).click();
  await page.getByLabel("Actual cash (SGD)", { exact: true }).fill("47.00");
  await page
    .getByLabel("Variance reason", { exact: true })
    .fill("Synthetic drawer-count draft");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Sell", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close shift", exact: true }).click();
  await expect(
    page.getByLabel("Actual cash (SGD)", { exact: true }),
  ).toHaveValue("47.00");
  await expect(page.getByLabel("Variance reason", { exact: true })).toHaveValue(
    "Synthetic drawer-count draft",
  );
});

test("Payment review rejects a newly depleted stock balance before confirmation", async ({
  page,
}) => {
  await ready(page, "Sparkling Water");
  await page
    .getByRole("button", { name: "Add Sparkling Water", exact: true })
    .click();
  const snapshot = await page.evaluate(async () => {
    const boot = await fetch("/api/v1/bootstrap").then((r) => r.json());
    const response = await fetch("/api/v1/sync/catalogue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": boot.csrf_token,
      },
      body: JSON.stringify({ offset: 0, sale_ids: [] }),
    });
    const request = indexedDB.open("counter-pos-v1");
    const database = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const products = await new Promise<
      { id: string; sku: string; quantity: number; balance_version: number }[]
    >((resolve) => {
      const read = database
        .transaction("products")
        .objectStore("products")
        .getAll();
      read.onsuccess = () => resolve(read.result);
    });
    database.close();
    const product = products.find((row) => row.sku === "DRK-002")!;
    if (!response.ok || !product) throw new Error("Stock fixture setup failed");
    const changed = await fetch("/api/v1/inventory/adjustments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": boot.csrf_token,
      },
      body: JSON.stringify({
        client_event_id: crypto.randomUUID(),
        product_id: product.id,
        counted_quantity: 0,
        expected_version: product.balance_version,
        reason: "Synthetic concurrent depletion",
      }),
    });
    if (!changed.ok) throw new Error("Stock fixture adjustment failed");
    return { id: product.id, quantity: product.quantity };
  });
  try {
    await page.getByRole("button", { name: /Take payment/ }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Insufficient stock: Sparkling Water",
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await stores(page)).sales).toBe(0);
  } finally {
    const restored = await page.evaluate(async (stock) => {
      const boot = await fetch("/api/v1/bootstrap").then((r) => r.json());
      return (
        await fetch("/api/v1/inventory/receipts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": boot.csrf_token,
          },
          body: JSON.stringify({
            client_event_id: crypto.randomUUID(),
            product_id: stock.id,
            quantity: stock.quantity,
            reason: "Restore isolated depleted-stock fixture",
          }),
        })
      ).status;
    }, snapshot);
    expect(restored).toBe(200);
  }
});

test("Externally reconciled rejected sale preserves its identity and unblocks shift close", async ({
  page,
}) => {
  await ready(page);
  await freshShift(page);
  await page.getByRole("button", { name: "Sell", exact: true }).click();
  const product = page.getByRole("button", {
    name: "Add Cold Brew",
    exact: true,
  });
  const original = Number(
    (await product.locator(".product-foot small").innerText()).match(
      /(\d+) left/,
    )![1],
  );
  const unsupportedRevision = crypto.randomUUID();
  let overridePrice = true;
  await page.route("**/api/v1/sync/catalogue", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        items: body.items.map((item: { sku: string }) =>
          overridePrice && item.sku === "DRK-001"
            ? { ...item, price_revision_id: unsupportedRevision }
            : item,
        ),
      },
    });
  });
  await product.click();
  await page.getByRole("button", { name: /Take payment/ }).click();
  await expect(page.getByRole("alert")).toContainText("Prices changed");
  await page.getByRole("button", { name: /Take payment/ }).click();
  await page.getByLabel("Cash received", { exact: true }).fill("20.00");
  await page.getByRole("button", { name: "Confirm cash received" }).click();
  await expect(
    page.getByText("Saved on this device — waiting to sync"),
  ).toBeVisible();
  await page.getByRole("button", { name: "New sale", exact: true }).click();
  overridePrice = false;
  await page.getByRole("button", { name: "Inventory", exact: true }).click();
  await page
    .locator(".stock-card")
    .filter({ hasText: "Cold Brew" })
    .getByRole("button", { name: "Count", exact: true })
    .click();
  await page
    .getByLabel("Physical counted units", { exact: true })
    .fill(String(original - 1));
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Physical correction for rejected synthetic cash sale");
  await page
    .getByRole("button", { name: "Post movement", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Close shift", exact: true }).click();
  await page
    .getByRole("button", { name: "Cash in / out", exact: true })
    .click();
  await page.getByLabel("Amount (SGD)", { exact: true }).fill("4.50");
  await page
    .getByLabel("Reason", { exact: true })
    .fill("External cash reconciliation for rejected synthetic sale");
  await page
    .getByRole("button", { name: "Record cash movement", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Sync center", exact: true }).click();
  await expect(page.getByText("NEEDS_REVIEW", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page
    .getByLabel("Reconciliation reason", { exact: true })
    .fill("Synthetic physical stock and cash entries completed");
  await page
    .getByLabel("External reconciliation reference", { exact: true })
    .fill("SYNTHETIC-BROWSER-EXT-001");
  let releaseSnapshot!: () => void, snapshotCaptured!: () => void;
  const snapshotReady = new Promise<void>((resolve) => {
    snapshotCaptured = resolve;
  });
  const snapshotRelease = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  let holdSnapshot = true;
  await page.route("**/api/v1/sync/catalogue", async (route) => {
    if (!holdSnapshot) return route.fallback();
    holdSnapshot = false;
    const response = await route.fetch();
    snapshotCaptured();
    await snapshotRelease;
    await route.fulfill({ response });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await snapshotReady;
  const recorded = page.waitForResponse(
    (response) =>
      response.url().includes("/resolve") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Record manager reconciliation", exact: true })
    .click();
  expect((await recorded).status()).toBe(200);
  releaseSnapshot();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText("EXTERNALLY_RESOLVED", { exact: true }),
  ).toBeVisible();
  expect(await stores(page)).toMatchObject({ sales: 1, outbox: 1, deltas: 0 });
  const expected = await page.evaluate(
    async () =>
      (await fetch("/api/v1/shifts/current").then((r) => r.json()))
        .expected_cash_minor as number,
  );
  await page.getByRole("button", { name: "Close shift", exact: true }).click();
  await page
    .getByLabel("Actual cash (SGD)", { exact: true })
    .fill((expected / 100).toFixed(2));
  await page
    .getByRole("button", { name: "Reconcile & close shift", exact: true })
    .click();
  await expect(
    page.getByText("No shift is open.", { exact: true }),
  ).toBeVisible();
  expect((await stores(page)).sales).toBe(1);
});

test("T12 account switch removes manager costs and keeps cashier catalogue cache safe", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "Products", exact: true }).click();
  await expect(
    page.getByRole("columnheader", { name: "Cost", exact: true }),
  ).toBeVisible();
  const switched = await page.evaluate(async () => {
    const response = await fetch("/api/v1/demo/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "CASHIER" }),
    });
    window.dispatchEvent(new Event("focus"));
    return response.status;
  });
  expect(switched).toBe(200);
  await expect(
    page.getByRole("button", { name: "Products", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("columnheader", { name: "Cost", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Sell", exact: true }),
  ).toBeVisible();
  const exposed = await page.evaluate(async () => {
    const request = indexedDB.open("counter-pos-v1");
    const database = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    const products = await new Promise<Record<string, unknown>[]>((resolve) => {
      const read = database
        .transaction("products")
        .objectStore("products")
        .getAll();
      read.onsuccess = () => resolve(read.result);
    });
    database.close();
    return products.some((product) => Object.hasOwn(product, "cost_minor"));
  });
  expect(exposed).toBe(false);
});

test("T04 canonical identity conflict remains visible until manager disposition and closes against the original receipt", async ({
  page,
}) => {
  await ready(page);
  await freshShift(page);
  await page.getByRole("button", { name: "Sell", exact: true }).click();
  const product = page.getByRole("button", {
    name: "Add Cold Brew",
    exact: true,
  });
  const quantity = async () =>
    Number(
      (await product.locator(".product-foot small").innerText()).match(
        /(\d+) left/,
      )![1],
    );
  const original = await quantity();
  let canonicalReceipt = "";
  await page.route(
    "**/api/v1/sync/register",
    async (route) => {
      const local = route.request().postDataJSON() as {
        client_created_at: string;
        client_sale_id: string;
      };
      const canonical = {
        ...local,
        client_created_at: new Date(
          Date.parse(local.client_created_at) - 1,
        ).toISOString(),
      };
      const posted = await route.fetch({
        url: "http://localhost:3001/api/v1/sales",
        method: "POST",
        postData: JSON.stringify(canonical),
        headers: {
          ...route.request().headers(),
          "Idempotency-Key": local.client_sale_id,
        },
      });
      expect(posted.status()).toBe(201);
      canonicalReceipt = (await posted.json()).receipt_no as string;
      await route.continue();
    },
    { times: 1 },
  );
  await product.click();
  await page.getByRole("button", { name: /Take payment/ }).click();
  await page.getByLabel("Cash received", { exact: true }).fill("20.00");
  await page.getByRole("button", { name: "Confirm cash received" }).click();
  await expect(
    page.getByText("Saved on this device — waiting to sync"),
  ).toBeVisible();
  await page.getByRole("button", { name: "New sale", exact: true }).click();
  await expect(product).toBeEnabled();
  expect(canonicalReceipt).not.toBe("");
  expect(await quantity()).toBe(original - 2);
  expect((await stores(page)).deltas).toBe(1);
  await page.getByRole("button", { name: "Sync center", exact: true }).click();
  await expect(
    page.getByText(/^IDEMPOTENCY_CONFLICT · \d+ attempts$/),
  ).toBeVisible();
  await expect(page.getByText("NEEDS_REVIEW", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page
    .getByLabel("Reconciliation reason", { exact: true })
    .fill(
      "Canonical receipt verified; one cash and stock posting retained, local timestamp conflict reconciled",
    );
  await page
    .getByLabel("External reconciliation reference", { exact: true })
    .fill(canonicalReceipt);
  await page
    .getByRole("button", { name: "Record manager reconciliation", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText("EXTERNALLY_RESOLVED", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Canonical receipt retained: " + canonicalReceipt, {
      exact: false,
    }),
  ).toBeVisible();
  expect((await stores(page)).deltas).toBe(0);
  await page.getByRole("button", { name: "Sell", exact: true }).click();
  expect(await quantity()).toBe(original - 1);
  const expected = await page.evaluate(
    async () =>
      (await fetch("/api/v1/shifts/current").then((r) => r.json()))
        .expected_cash_minor as number,
  );
  await page.getByRole("button", { name: "Close shift", exact: true }).click();
  await page
    .getByLabel("Actual cash (SGD)", { exact: true })
    .fill((expected / 100).toFixed(2));
  await page
    .getByRole("button", { name: "Reconcile & close shift", exact: true })
    .click();
  await expect(
    page.getByText("No shift is open.", { exact: true }),
  ).toBeVisible();
});

test("MYR checkout labels, opening float and receipt use the configured store currency", async ({
  page,
}) => {
  const { database } = await import("../../apps/api/src/db.ts");
  const url =
    process.env.TEST_DATABASE_URL ??
    "postgresql://counter_pos_owner@127.0.0.1:55432/counter_pos_test";
  const parsed = new URL(url);
  expect(parsed.pathname).toBe("/counter_pos_test");
  expect(["127.0.0.1", "localhost"]).toContain(parsed.hostname);
  const pool = database(url);
  let changedStore: { id: string; currency: string } | undefined;
  try {
    await ready(page);
    await freshShift(page, false);
    const boot = await page.evaluate(() =>
      fetch("/api/v1/bootstrap").then((response) => response.json()),
    );
    changedStore = (
      await pool.query("SELECT id,currency FROM stores WHERE id=$1", [
        boot.store.id,
      ])
    ).rows[0];
    await pool.query("UPDATE stores SET currency='MYR' WHERE id=$1", [
      changedStore!.id,
    ]);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Add Cold Brew", exact: true }),
    ).toBeEnabled({ timeout: 15000 });
    await page.getByRole("button", { name: "Open shift", exact: true }).click();
    await expect(
      page.getByLabel("Opening cash float (MYR)", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("SGD");
    await page
      .getByLabel("Opening cash float (MYR)", { exact: true })
      .fill("50.00");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Open shift", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Add Cold Brew", exact: true })
      .click();
    await expect(
      page.getByText("Line discount (MYR)", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Total MYR", { exact: true })).toBeVisible();
    await expect(page.locator(".grand")).toContainText("RM4.50");
    await page.getByRole("button", { name: /Take payment/ }).click();
    await expect(page.getByRole("dialog")).toContainText("AMOUNT DUE · MYR");
    await expect(page.getByRole("dialog")).toContainText("RM4.50");
    await expect(page.locator("body")).not.toContainText("SGD");
    await page.getByLabel("Cash received", { exact: true }).fill("5.00");
    await page
      .getByRole("button", { name: "Confirm cash received", exact: true })
      .click();
    await expect(
      page.getByRole("dialog").getByText("Synced", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toContainText("Total MYR");
    await expect(page.getByRole("dialog")).toContainText("RM4.50");
    await expect(page.locator("body")).not.toContainText("SGD");
    await page.screenshot({ path: "docs/qa/screenshots/receipt-myr.png" });
    const posted = await page.evaluate(() =>
      fetch("/api/v1/sales?limit=1").then((response) => response.json()),
    );
    expect(posted[0]).toMatchObject({ currency: "MYR", total_minor: 450 });
    await page.getByRole("button", { name: "New sale", exact: true }).click();
    await page
      .getByRole("button", { name: "Close shift", exact: true })
      .click();
    await expect(
      page.getByText("Opening float: RM50.00", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".grand")).toContainText("RM54.50");
    await expect(
      page.getByLabel("Actual cash (MYR)", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("SGD");
  } finally {
    if (changedStore) {
      try {
        const shift = await page.evaluate(() =>
          fetch("/api/v1/shifts/current").then((response) => response.json()),
        );
        if (shift) await freshShift(page, false);
      } finally {
        const restored = await pool.query(
          "UPDATE stores SET currency=$1 WHERE id=$2 RETURNING currency",
          [changedStore.currency, changedStore.id],
        );
        expect(restored.rows[0].currency).toBe(changedStore.currency);
      }
    }
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
