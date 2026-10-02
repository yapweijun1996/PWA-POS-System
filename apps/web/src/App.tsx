import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  Bootstrap,
  Product,
  Shift,
  Permit,
  SaleCommand,
} from "../../../packages/contracts/index.ts";
import {
  saleMoney,
  lineMoney,
  parseMoney,
  formatMoney,
} from "../../../packages/domain/money.ts";
import { api, probe, setCsrf, ApiError } from "./api.ts";
import {
  db,
  meta,
  putMeta,
  lease,
  selfTest,
  commitSale,
  localQuantities,
  type CartLine,
  type Outbox,
} from "./db.ts";
import { synchronize, pullCatalogue } from "./sync.ts";
import { registerWorker, activateWorker } from "./pwa.ts";
import { BackOffice } from "./BackOffice.tsx";
import { Dialog, Field, ProductArt, Empty } from "./components.tsx";
let trustedAnchor: { server: number; monotonic: number; wall: number } | null =
  null;
const navigation = [
  "Sell",
  "Products",
  "Inventory",
  "Sales",
  "Overview",
  "Sync center",
  "Close shift",
  "Settings",
];
export function App() {
  const [demo, setDemo] = useState(false),
    [boot, setBoot] = useState<Bootstrap | null>(null),
    [loading, setLoading] = useState(true),
    [online, setOnline] = useState(false),
    [writer, setWriter] = useState(false),
    [storage, setStorage] = useState(false),
    [products, setProducts] = useState<Product[]>([]),
    [shift, setShift] = useState<Shift | null>(null),
    [permit, setPermit] = useState<Permit | null>(null),
    [cart, setCart] = useState<CartLine[]>([]),
    [outbox, setOutbox] = useState<Outbox[]>([]),
    [screen, setScreen] = useState("Sell"),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState("All items"),
    [modal, setModal] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tender, setTender] = useState(""),
    [method, setMethod] = useState<"CASH" | "CARD_MANUAL" | "PAYNOW_MANUAL">(
      "CASH",
    ),
    [reference, setReference] = useState(""),
    [receipt, setReceipt] = useState<string | null>(null),
    [waiting, setWaiting] = useState<ServiceWorker | null>(null),
    [updating, setUpdating] = useState(false),
    [held, setHeld] = useState<
      { id: string; lines: CartLine[]; created: number }[]
    >([]),
    [undo, setUndo] = useState<CartLine | null>(null),
    [scrolled, setScrolled] = useState(false);
  const paymentTrigger = useRef<HTMLElement | null>(null),
    leaseOwned = useRef(false),
    authorized = useRef(false),
    confirmLock = useRef(false),
    searchRef = useRef<HTMLInputElement>(null),
    cartRef = useRef(cart);
  cartRef.current = cart;
  const money = (n: number) => formatMoney(n, boot?.store.currency ?? "SGD");
  const amount = cart.length
    ? saleMoney(
        cart.map((l) => ({
          quantity: l.quantity,
          unit_price_minor: l.product.unit_price_minor,
          discount_minor: l.discount_minor,
          tax_bps: l.product.tax_bps,
        })),
      )
    : { total_minor: 0, gross_minor: 0, discount_minor: 0, tax_minor: 0 };
  const pending = outbox.filter((o) => o.state !== "ACKED").length;
  const manager = boot?.user.role === "MANAGER";
  const ownShift = shift?.opened_by === boot?.user.id;
  async function refreshLocal() {
    const [items, delta, docs, h] = await Promise.all([
      db.products.toArray(),
      localQuantities(),
      db.outbox
        .orderBy("created_at")
        .reverse()
        .toArray()
        .catch(() => db.outbox.toArray()),
      db.held.toArray(),
    ]);
    setProducts(
      items
        .filter((p) => p.active)
        .sort((a, b) => a.sku.localeCompare(b.sku))
        .map((p) => ({ ...p, quantity: p.quantity + (delta.get(p.id) ?? 0) })),
    );
    setOutbox(docs);
    setHeld(h);
  }
  async function refresh() {
    await refreshLocal();
    if (await probe()) {
      setOnline(true);
      try {
        const s = await api<Shift | null>("/shifts/current");
        setShift(s);
        await putMeta("shift", s);
      } catch (e) {
        setError((e as Error).message);
      }
    } else setOnline(false);
  }
  async function authorize() {
    const b = await api<Bootstrap>("/bootstrap");
    setCsrf(b.csrf_token);
    authorized.current = true;
    setBoot(b);
    await putMeta("bootstrap", { ...b, csrf_token: "" });
    trustedAnchor = {
      server: Date.parse(b.server_time),
      wall: Date.now(),
      monotonic: performance.now(),
    };
    await pullCatalogue();
    await selfTest();
    setStorage(true);
    const s = await api<Shift | null>("/shifts/current");
    setShift(s);
    await putMeta("shift", s);
    if (s && s.opened_by === b.user.id) {
      const p = await api<Permit>(`/shifts/${s.id}/offline-permit`, {});
      setPermit(p);
      await putMeta("permit", p);
    }
    await refreshLocal();
    await synchronize(true);
    await refresh();
  }
  useEffect(() => {
    let stopped = false;
    void (async () => {
      try {
        setWriter(await lease());
        setCart((await meta<CartLine[]>("cart")) ?? []);
        setPermit((await meta<Permit>("permit")) ?? null);
        setShift((await meta<Shift>("shift")) ?? null);
        const connected = await probe();
        if (connected) {
          const status = await fetch("/health/live").then((r) => r.json());
          setDemo(status.demo === true);
        }
        if (stopped) return;
        setOnline(connected);
        if (connected) {
          try {
            await authorize();
          } catch {
            setBoot(null);
            await refreshLocal();
          }
        } else {
          const cached = (await meta<Bootstrap>("bootstrap")) ?? null;
          setBoot(cached);
          authorized.current = !!cached;
          await selfTest();
          setStorage(true);
          await refreshLocal();
        }
      } catch (e) {
        setError(
          "Local storage unavailable. Checkout is stopped. " +
            (e as Error).message,
        );
      } finally {
        if (!stopped) setLoading(false);
      }
    })();
    if (!import.meta.env.DEV)
      void registerWorker(setWaiting).catch((e) =>
        setError("Offline shell unavailable: " + e.message),
      );
    const interval = setInterval(() => {
      void lease()
        .then((owner) => {
          setWriter(owner);
          if (owner && !leaseOwned.current) void sync();
          leaseOwned.current = owner;
        })
        .catch(() => setWriter(false));
    }, 3000);
    const sync = async () => {
      const connected = await probe();
      setOnline(connected);
      if (connected && authorized.current) {
        try {
          const b = await api<Bootstrap>("/bootstrap");
          setCsrf(b.csrf_token);
          trustedAnchor = {
            server: Date.parse(b.server_time),
            wall: Date.now(),
            monotonic: performance.now(),
          };
          await synchronize();
          await refresh();
        } catch (e) {
          if (e instanceof ApiError && e.status === 401) {
            authorized.current = false;
            await db.outbox
              .filter((o) => o.state !== "ACKED" && o.state !== "NEEDS_REVIEW")
              .modify({ state: "AUTH_REQUIRED" });
            await refreshLocal();
            setBoot(null);
          }
          setError((e as Error).message);
        }
      }
    };
    const timer = setInterval(() => {
      void sync();
    }, 15000);
    window.addEventListener("online", sync);
    window.addEventListener("focus", sync);
    const off = () => setOnline(false);
    window.addEventListener("offline", off);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      stopped = true;
      clearInterval(interval);
      clearInterval(timer);
      window.removeEventListener("online", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("offline", off);
      window.removeEventListener("keydown", key);
    };
  }, []);
  async function login(
    e?: FormEvent<HTMLFormElement>,
    role?: "CASHIER" | "MANAGER",
  ) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (role) await api("/demo/login", { role });
      else {
        const f = new FormData(e!.currentTarget);
        await api("/auth/login", {
          email: String(f.get("email")),
          password: String(f.get("password")),
        });
      }
      await authorize();
      setOnline(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function changeCart(next: CartLine[]) {
    if (!writer || busy) return;
    try {
      if (next.length)
        saleMoney(
          next.map((l) => ({
            quantity: l.quantity,
            unit_price_minor: l.product.unit_price_minor,
            discount_minor: l.discount_minor,
            tax_bps: l.product.tax_bps,
          })),
        );
      await putMeta("cart", next);
      setCart(next);
    } catch (e) {
      setError("Order could not be saved: " + (e as Error).message);
    }
  }
  function add(p: Product) {
    const current = cartRef.current;
    const existing = current.find(
      (l) =>
        l.product.id === p.id &&
        l.product.price_revision_id === p.price_revision_id,
    );
    if (existing && existing.quantity >= 999) {
      setError("Maximum quantity is 999 per line");
      return;
    }
    if (!existing && current.length >= 100) {
      setError("Maximum 100 lines per sale");
      return;
    }
    const currentQ = current
      .filter((l) => l.product.id === p.id)
      .reduce((s, l) => s + l.quantity, 0);
    if (currentQ >= p.quantity) {
      setError("Insufficient available stock for " + p.name);
      return;
    }
    const next = existing
      ? current.map((l) =>
          l === existing ? { ...l, quantity: l.quantity + 1 } : l,
        )
      : [
          ...current,
          {
            product: p,
            quantity: 1,
            discount_minor: 0,
            line_id: crypto.randomUUID(),
          },
        ];
    cartRef.current = next;
    void changeCart(next);
  }
  async function paymentReview() {
    if (!cart.length) return;
    paymentTrigger.current = document.activeElement as HTMLElement;
    setBusy(true);
    try {
      if (online) {
        await pullCatalogue();
        const latest = await db.products.toArray();
        let changed = false;
        const reviewed = cart.map((l) => {
          const p = latest.find((p) => p.id === l.product.id);
          if (!p?.active)
            throw new Error("Product unavailable: " + l.product.name);
          if (p.price_revision_id !== l.product.price_revision_id) {
            changed = true;
            return { ...l, product: p, discount_minor: 0 };
          }
          return l;
        });
        if (changed) {
          await putMeta("cart", reviewed);
          setCart(reviewed);
          await refreshLocal();
          throw new Error(
            "Prices changed. Review the updated order, then take payment again.",
          );
        }
      }
      const available = products;
      for (const l of cart) {
        const p = available.find((p) => p.id === l.product.id);
        const requested = cart
          .filter((x) => x.product.id === l.product.id)
          .reduce((s, x) => s + x.quantity, 0);
        if (!p || requested > p.quantity)
          throw new Error("Insufficient stock: " + l.product.name);
      }
      if (!shift || !ownShift)
        throw new Error("Open your own shift before selling");
      if (!storage || !writer)
        throw new Error("This terminal is not ready to save sales");
      if (!online && !offlineReady())
        throw new Error(
          "Offline authorization is unavailable. Reconnect to verify time, catalogue and shift. Existing sales are preserved.",
        );
      setTender("");
      setMethod("CASH");
      setReference("");
      setModal("Take payment");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function offlineReady() {
    if (!trustedAnchor || !permit || !shift) return false;
    const elapsed = performance.now() - trustedAnchor.monotonic,
      wall = Date.now() - trustedAnchor.wall;
    if (Math.abs(wall - elapsed) > 5000) return false;
    return (
      trustedAnchor.server + elapsed < Date.parse(permit.expires_at) &&
      shift.opened_by === boot?.user.id
    );
  }
  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (confirmLock.current) return;
    confirmLock.current = true;
    setBusy(true);
    setError("");
    try {
      if (!shift || !boot) throw new Error("No open shift");
      if (!online && (!offlineReady() || method !== "CASH"))
        throw new Error("Offline cash authorization is unavailable");
      const cash = method === "CASH" ? parseMoney(tender) : amount.total_minor;
      if (cash < amount.total_minor)
        throw new Error("Tender is below the amount due");
      const lines = cart.map((l) => {
        const m = lineMoney({
          quantity: l.quantity,
          unit_price_minor: l.product.unit_price_minor,
          discount_minor: l.discount_minor,
          tax_bps: l.product.tax_bps,
        });
        return {
          line_id: l.line_id,
          product_id: l.product.id,
          price_revision_id: l.product.price_revision_id,
          sku_snapshot: l.product.sku,
          name_snapshot: l.product.name,
          quantity: l.quantity,
          unit_price_minor: l.product.unit_price_minor,
          discount_minor: l.discount_minor,
          tax_bps: l.product.tax_bps,
          tax_minor: m.tax_minor,
          line_total_minor: m.line_total_minor,
        };
      });
      const created = trustedAnchor
        ? new Date(
            trustedAnchor.server + performance.now() - trustedAnchor.monotonic,
          ).toISOString()
        : new Date().toISOString();
      const payload: SaleCommand = {
        schema_version: 1,
        client_sale_id: crypto.randomUUID(),
        device_id: shift.device_id,
        shift_id: shift.id,
        client_created_at: created,
        was_offline: !online,
        ...(!online ? { offline_permit_id: permit!.id } : {}),
        currency: boot.store.currency as "SGD" | "MYR",
        lines,
        payment: {
          method,
          amount_applied_minor: amount.total_minor,
          tender_minor: cash,
          change_minor: cash - amount.total_minor,
          ...(method === "CASH"
            ? {}
            : { external_reference: reference, operator_verified_at: created }),
        },
        ...amount,
      };
      await commitSale(payload, { actor_id: boot.user.id });
      setCart([]);
      setReceipt(payload.client_sale_id);
      setModal("Receipt");
      await refreshLocal();
      if (online) {
        await synchronize(true);
        await refresh();
      }
    } catch (e) {
      setError("Sale not saved: " + (e as Error).message);
    } finally {
      setBusy(false);
      confirmLock.current = false;
    }
  }
  async function openShift(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const f = new FormData(e.currentTarget);
      const s = await api<Shift>("/shifts", {
        device_id: boot!.devices.find((d) => !d.revoked_at)!.id,
        opening_float_minor: parseMoney(String(f.get("float"))),
      });
      setShift(s);
      await putMeta("shift", s);
      const p = await api<Permit>(`/shifts/${s.id}/offline-permit`, {});
      setPermit(p);
      await putMeta("permit", p);
      setModal(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function hold() {
    if (!cart.length) return;
    try {
      await db.transaction("rw", [db.held, db.meta], async () => {
        await db.held.add({
          id: crypto.randomUUID(),
          lines: cart,
          created: Date.now(),
        });
        await putMeta("cart", []);
      });
      setCart([]);
      await refreshLocal();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function restoreHeld(id: string) {
    try {
      const h = await db.held.get(id);
      if (!h) return;
      if (cart.length) throw new Error("Hold or clear the current order first");
      await db.transaction("rw", [db.held, db.meta], async () => {
        await putMeta("cart", h.lines);
        await db.held.delete(id);
      });
      setCart(h.lines);
      setModal(null);
      await refreshLocal();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function logout() {
    if (pending) {
      setError(
        "Synchronize or export unresolved sales before logging out. Records are preserved.",
      );
      return;
    }
    try {
      await api("/auth/logout", {});
      setBoot(null);
      authorized.current = false;
      trustedAnchor = null;
      await db.meta.delete("bootstrap");
      await db.meta.delete("permit");
      setPermit(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  let tenderMinor = -1;
  try {
    tenderMinor = parseMoney(tender);
  } catch {
    /* An invalid tender never enables confirmation. */
  }
  const saved = outbox.find((o) => o.id === receipt);
  const order = (
    <div className="order-body">
      <div className="order-heading">
        <div>
          <h2>Current order</h2>
          <p>
            Walk-in customer · {cart.reduce((s, l) => s + l.quantity, 0)} items
          </p>
        </div>
        <button
          disabled={!writer || !cart.length}
          onClick={() => setModal("Clear order")}
        >
          Clear
        </button>
      </div>
      <div className="order-meta">
        <span>Stock updates when the sale posts</span>
        <button disabled={!writer || !cart.length} onClick={() => void hold()}>
          Hold
        </button>
      </div>
      <div className="cart-lines">
        {cart.length ? (
          cart.map((l) => (
            <article className="cart-line" key={l.line_id}>
              <div className="line-top">
                <strong>{l.product.name}</strong>
                <strong>
                  {money(
                    lineMoney({
                      quantity: l.quantity,
                      unit_price_minor: l.product.unit_price_minor,
                      discount_minor: l.discount_minor,
                      tax_bps: l.product.tax_bps,
                    }).line_total_minor,
                  )}
                </strong>
              </div>
              <p>{money(l.product.unit_price_minor)} each</p>
              <div className="quantity">
                <button
                  aria-label={"Decrease " + l.product.name}
                  disabled={!writer}
                  onClick={() => {
                    if (l.quantity === 1) {
                      setUndo(l);
                      void changeCart(cart.filter((x) => x !== l));
                    } else
                      void changeCart(
                        cart.map((x) =>
                          x === l ? { ...l, quantity: l.quantity - 1 } : x,
                        ),
                      );
                  }}
                >
                  −
                </button>
                <span>{l.quantity}</span>
                <button
                  aria-label={"Increase " + l.product.name}
                  disabled={!writer || l.quantity >= 999}
                  onClick={() => add(l.product)}
                >
                  +
                </button>
                <button
                  className="text"
                  disabled={!writer}
                  onClick={() => {
                    setUndo(l);
                    void changeCart(cart.filter((x) => x !== l));
                  }}
                >
                  Remove
                </button>
              </div>
              {manager && online && (
                <Field label="Line discount (SGD)">
                  <input
                    aria-label={"Discount " + l.product.name}
                    key={l.line_id + "discount"}
                    type="number"
                    step="0.01"
                    min="0"
                    max={(l.quantity * l.product.unit_price_minor) / 100}
                    defaultValue={l.discount_minor / 100}
                    onBlur={(e) => {
                      try {
                        const discount = parseMoney(e.target.value);
                        if (discount > l.quantity * l.product.unit_price_minor)
                          throw new Error("Discount exceeds line amount");
                        void changeCart(
                          cart.map((x) =>
                            x === l ? { ...l, discount_minor: discount } : x,
                          ),
                        );
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  />
                </Field>
              )}
            </article>
          ))
        ) : (
          <Empty text="Tap a product to start an order." />
        )}
      </div>
      {undo && (
        <div className="notice">
          Item removed.
          <button
            onClick={() => {
              void changeCart([...cart, undo]);
              setUndo(null);
            }}
          >
            Undo
          </button>
        </div>
      )}
      <div className="totals">
        <div>
          <span>Subtotal</span>
          <span>{money(amount.gross_minor)}</span>
        </div>
        <div>
          <span>Discount</span>
          <span>{money(amount.discount_minor)}</span>
        </div>
        <div>
          <span>Tax (disabled)</span>
          <span>{money(0)}</span>
        </div>
        <div className="grand">
          <span>Total SGD</span>
          <strong>{money(amount.total_minor)}</strong>
        </div>
        <button
          className="primary full"
          disabled={busy || !cart.length || !writer || !ownShift || !storage}
          onClick={() => void paymentReview()}
        >
          Take payment <span>{money(amount.total_minor)} →</span>
        </button>
      </div>
    </div>
  );
  if (loading)
    return (
      <main className="startup">
        <div className="spinner" />
        <h1>Opening Counter POS</h1>
        <p>Checking terminal and saved records…</p>
      </main>
    );
  if (!boot)
    return (
      <main className="login">
        <section className="login-art">
          <div className="brand">
            <span>▦</span>counter
          </div>
          <div>
            <p className="eyebrow">A CALMER WAY TO SELL</p>
            <h1>
              A small counter.
              <br />A complete day.
            </h1>
            <p>
              Products, sales and stock, together.
              <br />
              Built for the everyday retail rhythm.
            </p>
          </div>
          <p>Single-store focus · Cash-first offline</p>
        </section>
        <section className="login-form">
          <p className="eyebrow">COUNTER POS / EVERYDAY STORE</p>
          <h2>Open your workspace</h2>
          <p>Sign in online and verify this terminal before opening a shift.</p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {!online && (
            <p className="notice">
              Offline. First sign-in requires connectivity. Previously saved
              documents remain on this device.
            </p>
          )}
          <form onSubmit={(e) => void login(e)}>
            <Field label="Email">
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
              />
            </Field>
            <Field label="Password">
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <button className="primary full" disabled={busy || !online}>
              Sign in
            </button>
          </form>
          {demo && (
            <div className="demo-access">
              <p>Synthetic local demonstration · No real payments</p>
              <button
                disabled={busy || !online}
                onClick={() => void login(undefined, "MANAGER")}
              >
                Enter manager demo
              </button>
              <button
                disabled={busy || !online}
                onClick={() => void login(undefined, "CASHIER")}
              >
                Enter cashier demo
              </button>
            </div>
          )}
          {pending > 0 && (
            <p className="notice">
              {pending} saved transactions await reauthentication. Sign in as
              the original operator to resume.
            </p>
          )}
        </section>
      </main>
    );
  const matches = products.filter(
    (p) =>
      (category === "All items" || p.category_name === category) &&
      (p.name + " " + p.sku + " " + p.barcode)
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="demo-ribbon">
        {demo ? "SYNTHETIC WORKSPACE · " : ""}No real payment processing{" "}
        <span>Counter POS · V1</span>
      </div>
      <div className="app-shell">
        <aside className="rail">
          <div className="brand">
            <span>▦</span>
            <div>
              counter<small>POINT OF SALE</small>
            </div>
          </div>
          <nav aria-label="Main navigation">
            {navigation
              .filter(
                (n) =>
                  manager ||
                  !["Products", "Inventory", "Overview", "Settings"].includes(
                    n,
                  ),
              )
              .map((n, i) => (
                <button
                  key={n}
                  className={screen === n ? "active" : ""}
                  onClick={() => {
                    setScreen(n);
                    setModal(null);
                    setError("");
                  }}
                >
                  <span aria-hidden="true">
                    {["▦", "◇", "▱", "▤", "▥", "↻", "▣", "⚙"][i]}
                  </span>
                  {n}
                </button>
              ))}
          </nav>
          <div className="store-footer">
            <strong>{boot.store.name}</strong>
            <p>
              {shift ? "Shift open · " + shift.business_date : "No open shift"}
            </p>
            <button onClick={() => void logout()}>Sign out</button>
          </div>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <div>
              <p className="eyebrow">
                {boot.store.name.toUpperCase()} / COUNTER 01
              </p>
              <h1>{screen}</h1>
            </div>
            <div className="top-actions">
              <button
                className={"badge " + (!online || pending ? "amber" : "")}
                onClick={() => setScreen("Sync center")}
                aria-label="Open sync center"
              >
                ● {online ? "Online" : "Offline"} ·{" "}
                {pending ? pending + " pending" : "Synced"}
              </button>
              <div className="operator">
                <span className="avatar">AL</span>
                <div>
                  <strong>{boot.user.display_name}</strong>
                  <small>{boot.user.role.toLowerCase()}</small>
                </div>
              </div>
            </div>
          </header>
          <nav className="mobile-nav" aria-label="Mobile navigation">
            <select
              aria-label="Screen"
              value={screen}
              onChange={(e) => setScreen(e.target.value)}
            >
              {navigation
                .filter(
                  (n) =>
                    manager ||
                    !["Products", "Inventory", "Overview", "Settings"].includes(
                      n,
                    ),
                )
                .map((n) => (
                  <option key={n}>{n}</option>
                ))}
            </select>
            <button onClick={() => void logout()}>Sign out</button>
          </nav>
          {error && (
            <div role="alert" className="error global-error">
              {error}
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                ×
              </button>
            </div>
          )}
          {!writer && (
            <div className="notice">
              Read-only tab. Another tab owns this terminal. It becomes writable
              when that lease expires.
            </div>
          )}
          {!shift && (
            <div className="notice">
              Open a cash shift to start selling.
              <button
                disabled={!online || busy}
                onClick={() => setModal("Open shift")}
              >
                Open shift
              </button>
            </div>
          )}
          {shift && !ownShift && (
            <div className="notice">
              The open shift belongs to another operator. Selling is disabled
              for this account.
            </div>
          )}
          {!online && (
            <div className="notice">
              Offline · cash only.{" "}
              {offlineReady()
                ? "Authorized within the current permit."
                : "Reconnect to verify authorization before new sales."}{" "}
              Saved sales wait for foreground sync.
            </div>
          )}
          <main
            className={"main " + (screen === "Sell" ? "selling" : "")}
            onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 600)}
          >
            {screen === "Sell" ? (
              <div className="sell-layout">
                <section className="catalogue">
                  <div className="search-row">
                    <input
                      ref={searchRef}
                      aria-label="Search products"
                      placeholder="Search products or scan a barcode"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const p = products.find(
                            (p) =>
                              p.barcode === search ||
                              p.sku === search.toUpperCase(),
                          );
                          if (p) {
                            add(p);
                            setSearch("");
                          } else
                            setError(
                              "Product not found. Search by name or SKU.",
                            );
                        }
                      }}
                    />
                    <button
                      aria-label="Barcode scanner help"
                      onClick={() => setModal("Barcode scanner")}
                    >
                      ▥
                    </button>
                  </div>
                  <div className="chips">
                    {[
                      "All items",
                      ...new Set(products.map((p) => p.category_name)),
                    ].map((c) => (
                      <button
                        key={c}
                        className={category === c ? "active" : ""}
                        onClick={() => setCategory(c)}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                  <div className="countline">
                    <span>Quick picks</span>
                    <span>{matches.length} products · Tax off</span>
                  </div>
                  <div className="products-grid">
                    {matches.map((p) => (
                      <button
                        className="product"
                        key={p.id}
                        disabled={!writer || p.quantity <= 0 || busy}
                        aria-label={"Add " + p.name}
                        onClick={() => add(p)}
                      >
                        <div className={"art " + p.category_name.toLowerCase()}>
                          <ProductArt product={p} />
                          {cart
                            .filter((l) => l.product.id === p.id)
                            .reduce((s, l) => s + l.quantity, 0) > 0 && (
                            <span className="selected-count">
                              {cart
                                .filter((l) => l.product.id === p.id)
                                .reduce((s, l) => s + l.quantity, 0)}
                            </span>
                          )}
                        </div>
                        <h3>{p.name}</h3>
                        <div className="product-foot">
                          <strong>{money(p.unit_price_minor)}</strong>
                          <small
                            className={
                              p.quantity <= p.low_stock_threshold
                                ? "warning"
                                : ""
                            }
                          >
                            {p.quantity <= p.low_stock_threshold
                              ? "Low · "
                              : ""}
                            {p.quantity} left
                          </small>
                        </div>
                      </button>
                    ))}
                  </div>
                  {!matches.length && (
                    <Empty text="No products match. Try a name, SKU or barcode." />
                  )}
                  <p className="footnote">
                    Tap a product to add it. Pending local stock is included
                    once.
                  </p>
                  <button
                    disabled={!held.length}
                    onClick={() => setModal("Held orders")}
                  >
                    Held orders ({held.length})
                  </button>
                </section>
                <aside className="order" aria-label="Current order">
                  {order}
                </aside>
              </div>
            ) : (
              <BackOffice
                writer={writer}
                screen={screen}
                boot={boot}
                products={products}
                shift={shift}
                online={online}
                refresh={refresh}
                error={setError}
                outbox={outbox}
                openShift={() => setModal("Open shift")}
              />
            )}
          </main>
          {scrolled && screen !== "Sell" && (
            <button
              className="scroll-top"
              aria-label="Scroll to top"
              onClick={() =>
                document.querySelector(".main")?.scrollTo({
                  top: 0,
                  behavior: matchMedia("(prefers-reduced-motion: reduce)")
                    .matches
                    ? "instant"
                    : "smooth",
                })
              }
            >
              ↑
            </button>
          )}
          {screen === "Sell" && (
            <div className="mobile-order">
              <button
                className="primary full"
                onClick={() => setModal("Current order")}
              >
                View order · {cart.reduce((s, l) => s + l.quantity, 0)} items{" "}
                <span>{money(amount.total_minor)} →</span>
              </button>
            </div>
          )}
        </div>
      </div>
      {waiting && (
        <div className="update-banner" role="status">
          <div>
            <strong>New version available</strong>
            <p>
              {busy || pending || modal === "Take payment" || cart.length
                ? "Finish checkout and sync pending sales before updating."
                : "Ready to update."}
            </p>
          </div>
          <button
            disabled={
              busy ||
              pending > 0 ||
              cart.length > 0 ||
              modal === "Take payment" ||
              updating
            }
            onClick={() => {
              setUpdating(true);
              void activateWorker(waiting)
                .then(() => location.reload())
                .catch((e) => {
                  setUpdating(false);
                  setError(e.message);
                });
            }}
          >
            Update now
          </button>
        </div>
      )}
      {updating && (
        <div className="updating" role="status">
          <div className="spinner" />
          <h2>Updating Counter POS</h2>
          <p>Installing the latest version…</p>
        </div>
      )}
      {modal && (
        <Dialog
          title={modal}
          returnFocus={
            modal === "Take payment" ? paymentTrigger.current : undefined
          }
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          {modal === "Current order" && order}
          {modal === "Clear order" && (
            <>
              <p>Clear this draft? Posted and held sales are preserved.</p>
              <button
                className="primary"
                onClick={() => {
                  void changeCart([]);
                  setModal(null);
                }}
              >
                Clear draft
              </button>
            </>
          )}
          {modal === "Open shift" && (
            <form onSubmit={(e) => void openShift(e)}>
              <p>Counter 01 · {boot.user.display_name}</p>
              <Field label="Opening cash float (SGD)">
                <input
                  name="float"
                  inputMode="decimal"
                  defaultValue="100.00"
                  required
                />
              </Field>
              <button className="primary full" disabled={busy || !online}>
                {busy ? "Opening…" : "Open shift"}
              </button>
            </form>
          )}
          {modal === "Take payment" && (
            <form onSubmit={(e) => void confirm(e)}>
              <p className="eyebrow">AMOUNT DUE · SGD</p>
              <div className="payment-due">{money(amount.total_minor)}</div>
              <div className="methods">
                {(["CASH", "CARD_MANUAL", "PAYNOW_MANUAL"] as const).map(
                  (m) => (
                    <button
                      key={m}
                      type="button"
                      className={method === m ? "active" : ""}
                      disabled={!online && m !== "CASH"}
                      onClick={() => setMethod(m)}
                    >
                      {m === "CASH"
                        ? "Cash"
                        : m === "CARD_MANUAL"
                          ? "Card"
                          : "PayNow"}
                    </button>
                  ),
                )}
              </div>
              {method === "CASH" ? (
                <>
                  <Field label="Cash received (SGD)">
                    <input
                      aria-label="Cash received"
                      inputMode="decimal"
                      value={tender}
                      onChange={(e) => setTender(e.target.value)}
                    />
                  </Field>
                  <div className="quick-cash">
                    {[amount.total_minor, 2000, 5000]
                      .filter(
                        (v, i, a) =>
                          v >= amount.total_minor && a.indexOf(v) === i,
                      )
                      .map((v) => (
                        <button
                          type="button"
                          key={v}
                          onClick={() => setTender((v / 100).toFixed(2))}
                        >
                          {money(v)}
                        </button>
                      ))}
                  </div>
                  <div className="grand">
                    <span>Change</span>
                    <strong>
                      {money(Math.max(0, tenderMinor - amount.total_minor))}
                    </strong>
                  </div>
                </>
              ) : (
                <>
                  <p className="notice">
                    Recorded externally. Confirm the payment in the external
                    terminal or merchant channel before recording. This POS does
                    not verify the provider.
                  </p>
                  <Field label="Non-sensitive external reference">
                    <input
                      maxLength={120}
                      required
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                    />
                  </Field>
                </>
              )}
              {!online && <p>Offline: Card and PayNow are unavailable.</p>}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button
                className="primary full"
                disabled={
                  busy ||
                  !writer ||
                  (method === "CASH"
                    ? tenderMinor < amount.total_minor
                    : !reference.trim())
                }
              >
                {busy
                  ? "Saving sale…"
                  : method === "CASH"
                    ? "Confirm cash received"
                    : "Record external payment"}
              </button>
              <p className="footnote">
                A saved sale cannot be edited. Printing does not create a sale.
              </p>
            </form>
          )}
          {modal === "Receipt" && saved && (
            <>
              <p
                className={"badge " + (saved.state === "ACKED" ? "" : "amber")}
              >
                {saved.state === "ACKED"
                  ? "Synced"
                  : "Saved on this device — waiting to sync"}
              </p>
              <div className="receipt">
                <h3>{boot.store.name.toUpperCase()}</h3>
                <p>
                  {saved.posted?.receipt_no ?? "LOCAL-" + saved.id.slice(0, 8)}
                </p>
                <small>
                  {new Date(saved.payload.client_created_at).toLocaleString()}
                </small>
                <hr />
                {saved.payload.lines.map((l) => (
                  <div className="list-row" key={l.line_id}>
                    <span>
                      {l.quantity} × {l.name_snapshot}
                    </span>
                    <span>{money(l.line_total_minor)}</span>
                  </div>
                ))}
                <div className="grand">
                  <span>Total SGD</span>
                  <strong>{money(saved.payload.total_minor)}</strong>
                </div>
                <div className="list-row">
                  <span>
                    {saved.payload.payment.method === "CASH"
                      ? "Cash received"
                      : "Recorded externally"}
                  </span>
                  <span>{money(saved.payload.payment.tender_minor)}</span>
                </div>
                <div className="list-row">
                  <span>Change</span>
                  <span>{money(saved.payload.payment.change_minor)}</span>
                </div>
                <p className="footnote">SYNTHETIC · NOT A TAX INVOICE</p>
                <small className="uuid">Sale UUID: {saved.id}</small>
              </div>
              <div className="receipt-actions">
                <button
                  onClick={() => {
                    try {
                      window.print();
                    } catch {
                      setError("Printing failed. The saved sale is preserved.");
                    }
                  }}
                >
                  Print receipt
                </button>
                <button
                  className="primary"
                  onClick={() => {
                    setModal(null);
                    setReceipt(null);
                  }}
                >
                  New sale
                </button>
              </div>
            </>
          )}
          {modal === "Held orders" && (
            <>
              {held.map((h) => (
                <div className="list-row" key={h.id}>
                  <span>
                    {h.lines.reduce((s, l) => s + l.quantity, 0)} items ·{" "}
                    {new Date(h.created).toLocaleTimeString()}
                  </span>
                  <button
                    disabled={!writer}
                    onClick={() => void restoreHeld(h.id)}
                  >
                    Restore
                  </button>
                </div>
              ))}
              <p>
                Held orders do not reserve stock. Prices are checked again at
                payment.
              </p>
            </>
          )}
          {modal === "Barcode scanner" && (
            <p>
              Use a USB or Bluetooth keyboard-wedge scanner configured with an
              Enter suffix. Focus the search field and scan a SKU or barcode.
              Unknown codes show an error. Scanning never submits payment.
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}
