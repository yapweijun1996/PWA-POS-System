import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { Dialog, Field } from "../../web/src/components.tsx";
import {
  formatMoney,
  parseMoney,
  saleMoney,
} from "../../../packages/domain/money.ts";
import "../../web/src/style.css";
import "./style.css";

type DemoProduct = {
  sku: string;
  name: string;
  category: string;
  price: number;
  units: number;
};
declare const __DEMO_PRODUCTS__: DemoProduct[];
const products = __DEMO_PRODUCTS__;
const base = import.meta.env.BASE_URL;
const key = "counter-static-v1:" + base;
const lineSchema = z
  .object({
    sku: z.string().refine((s) => products.some((p) => p.sku === s)),
    quantity: z.number().int().min(1).max(200),
  })
  .strict();
const receiptSchema = z
  .object({
    id: z.uuid(),
    at: z.iso.datetime(),
    lines: z.array(lineSchema).min(1).max(12),
    total: z.number().int().positive(),
    tender: z.number().int().positive(),
    change: z.number().int().min(0),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    stock: z.record(z.string(), z.number().int().min(0)),
    cart: z.array(lineSchema).max(12),
    receipts: z.array(receiptSchema).max(100),
  })
  .strict()
  .refine(
    (s) =>
      Object.keys(s.stock).length === products.length &&
      products.every(
        (p) => typeof s.stock[p.sku] === "number" && s.stock[p.sku] <= p.units,
      ) &&
      new Set(s.cart.map((l) => l.sku)).size === s.cart.length &&
      s.cart.every((l) => l.quantity <= s.stock[l.sku]),
  );
type DemoState = z.infer<typeof stateSchema>;
const initial = (): DemoState => ({
  version: 1,
  stock: Object.fromEntries(products.map((p) => [p.sku, p.units])),
  cart: [],
  receipts: [],
});
function load() {
  try {
    const value = localStorage.getItem(key);
    return value ? stateSchema.parse(JSON.parse(value)) : initial();
  } catch {
    return initial();
  }
}
const money = (n: number) => formatMoney(n, "SGD");
function total(lines: DemoState["cart"]) {
  return lines.length
    ? saleMoney(
        lines.map((l) => ({
          quantity: l.quantity,
          unit_price_minor: products.find((p) => p.sku === l.sku)!.price,
          discount_minor: 0,
          tax_bps: 0,
        })),
      ).total_minor
    : 0;
}
function StaticDemo() {
  const [state, setState] = useState(load);
  const [screen, setScreen] = useState("Sell");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All items");
  const [modal, setModal] = useState<"pay" | "receipt" | "reset" | null>(null);
  const [tender, setTender] = useState("");
  const [receiptId, setReceiptId] = useState("");
  const [error, setError] = useState("");
  const confirmed = useRef(false);
  const due = total(state.cart);
  let received: number | null = null;
  try {
    received = parseMoney(tender);
  } catch {
    /* Invalid cash input keeps confirmation disabled. */
  }
  const receipt = state.receipts.find((r) => r.id === receiptId);
  const shown = products.filter(
    (p) =>
      (category === "All items" || p.category === category) &&
      (p.name + " " + p.sku).toLowerCase().includes(search.toLowerCase()),
  );
  function save(next: DemoState) {
    try {
      localStorage.setItem(key, JSON.stringify(stateSchema.parse(next)));
      setState(next);
      setError("");
      return true;
    } catch {
      setError(
        "Demo storage is unavailable or full. Your order has not been changed.",
      );
      return false;
    }
  }
  function quantity(sku: string, amount: number) {
    const previous = state.cart.find((l) => l.sku === sku)?.quantity ?? 0;
    const next = previous + amount;
    if (next > state.stock[sku]) {
      setError("Not enough sample stock for this order.");
      return;
    }
    save({
      ...state,
      cart: [
        ...state.cart.filter((l) => l.sku !== sku),
        ...(next > 0 ? [{ sku, quantity: next }] : []),
      ],
    });
  }
  function confirm() {
    if (
      confirmed.current ||
      received === null ||
      received < due ||
      !state.cart.length
    )
      return;
    confirmed.current = true;
    const record = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      lines: structuredClone(state.cart),
      total: due,
      tender: received,
      change: received - due,
    };
    const stock = { ...state.stock };
    for (const l of state.cart) stock[l.sku] -= l.quantity;
    if (
      !save({
        ...state,
        stock,
        cart: [],
        receipts: [...state.receipts, record].slice(-100),
      })
    ) {
      confirmed.current = false;
      return;
    }
    setReceiptId(record.id);
    setModal("receipt");
  }
  const cart = (
    <aside className="pages-cart" aria-label="Current order">
      <h2>Current order</h2>
      <p>Sample customer · Simulation only</p>
      {!state.cart.length && <p>Add a product to try a cash checkout.</p>}
      {state.cart.map((l) => {
        const p = products.find((p) => p.sku === l.sku)!;
        return (
          <div className="pages-line" key={l.sku}>
            <div>
              <strong>{p.name}</strong>
              <small>{money(p.price)} each</small>
            </div>
            <strong>{money(p.price * l.quantity)}</strong>
            <div className="pages-quantity">
              <button
                aria-label={"Decrease " + p.name}
                onClick={() => quantity(l.sku, -1)}
              >
                −
              </button>
              <span>{l.quantity}</span>
              <button
                aria-label={"Increase " + p.name}
                onClick={() => quantity(l.sku, 1)}
              >
                +
              </button>
            </div>
            <button
              onClick={() =>
                save({
                  ...state,
                  cart: state.cart.filter((row) => row.sku !== l.sku),
                })
              }
            >
              Remove
            </button>
          </div>
        );
      })}
      <div className="pages-total">
        <span>Total SGD</span>
        <strong>{money(due)}</strong>
      </div>
      <button
        className="primary full"
        disabled={!state.cart.length}
        onClick={() => {
          confirmed.current = false;
          setTender("");
          setModal("pay");
        }}
      >
        Take payment <span>{money(due)} →</span>
      </button>
      <small>No actual payment is collected.</small>
    </aside>
  );
  return (
    <>
      <div className="demo-ribbon">
        STATIC DEMO · Synthetic data · No real payments
      </div>
      <div className="pages-frame">
        <aside className="pages-nav">
          <h2>▦ counter</h2>
          <p>POINT OF SALE</p>
          <nav aria-label="Demo navigation">
            {["Sell", "Products", "Inventory", "Sales"].map((n) => (
              <button
                key={n}
                aria-current={screen === n ? "page" : undefined}
                onClick={() => setScreen(n)}
              >
                {n}
              </button>
            ))}
          </nav>
          <button onClick={() => setModal("reset")}>Reset demo</button>
        </aside>
        <section>
          <header className="pages-header">
            <div>
              <p className="eyebrow">Everyday Store / Browser demo</p>
              <h1>{screen}</h1>
            </div>
            <span className="badge">Simulation only</span>
          </header>
          <main className="pages-main">
            <p className="pages-note">
              Try sample products, a cash checkout and receipts. Demo records
              stay in this browser. Accounts, refunds and server synchronization
              require the full application.
            </p>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            {(screen === "Sell" || screen === "Products") && (
              <div className={screen === "Sell" ? "pages-layout" : ""}>
                <section>
                  <Field label="Search products">
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search by name or SKU"
                    />
                  </Field>
                  <div className="pages-filters">
                    {[
                      "All items",
                      ...new Set(products.map((p) => p.category)),
                    ].map((n) => (
                      <button
                        key={n}
                        aria-pressed={category === n}
                        onClick={() => setCategory(n)}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                  <div className="pages-products">
                    {shown.map((p) => (
                      <button
                        className="pages-product"
                        key={p.sku}
                        aria-label={"Add " + p.name}
                        disabled={state.stock[p.sku] === 0}
                        onClick={() => {
                          quantity(p.sku, 1);
                          setScreen("Sell");
                        }}
                      >
                        <img
                          className="product-art"
                          src={base + "products/" + p.sku + ".svg"}
                          alt=""
                        />
                        <strong>{p.name}</strong>
                        <div>
                          <strong>{money(p.price)}</strong>
                          <small>{state.stock[p.sku]} left</small>
                        </div>
                      </button>
                    ))}
                  </div>
                  {!shown.length && (
                    <p>No sample products match your search.</p>
                  )}
                </section>
                {screen === "Sell" && cart}
              </div>
            )}
            {screen === "Inventory" && (
              <div className="pages-table">
                <table>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th>Product</th>
                      <th>Sample stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p) => (
                      <tr key={p.sku}>
                        <td>{p.sku}</td>
                        <td>{p.name}</td>
                        <td>{state.stock[p.sku]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {screen === "Sales" && (
              <section>
                <p>
                  {state.receipts.length} simulated receipts ·{" "}
                  {money(state.receipts.reduce((sum, r) => sum + r.total, 0))}{" "}
                  total
                </p>
                {!state.receipts.length && (
                  <p>No demo sales yet. Try a cash checkout.</p>
                )}
                {[...state.receipts].reverse().map((r) => (
                  <button
                    className="pages-sale"
                    key={r.id}
                    onClick={() => {
                      setReceiptId(r.id);
                      setModal("receipt");
                    }}
                  >
                    <span>
                      DEMO-{r.id.slice(0, 8)}
                      <small>{new Date(r.at).toLocaleString()}</small>
                    </span>
                    <strong>{money(r.total)}</strong>
                  </button>
                ))}
              </section>
            )}
          </main>
        </section>
      </div>
      {modal && (
        <Dialog
          title={
            modal === "pay"
              ? "Take payment"
              : modal === "receipt"
                ? "Demo receipt"
                : "Reset demo"
          }
          close={() => setModal(null)}
        >
          {modal === "pay" && (
            <>
              <p className="eyebrow">Simulated amount due · SGD</p>
              <div className="payment-due">{money(due)}</div>
              <Field label="Cash received">
                <input
                  inputMode="decimal"
                  value={tender}
                  onChange={(e) => setTender(e.target.value)}
                />
              </Field>
              <p>
                Simulated change:{" "}
                {received !== null && received >= due
                  ? money(received - due)
                  : "—"}
              </p>
              <button
                className="primary full"
                disabled={
                  received === null || received < due || !state.cart.length
                }
                onClick={confirm}
              >
                Simulate cash sale
              </button>
            </>
          )}
          {modal === "receipt" && receipt && (
            <>
              <div className="receipt">
                <h3>EVERYDAY STORE</h3>
                <p>DEMO-{receipt.id.slice(0, 8)}</p>
                {receipt.lines.map((l) => (
                  <div className="list-row" key={l.sku}>
                    <span>
                      {l.quantity} ×{" "}
                      {products.find((p) => p.sku === l.sku)!.name}
                    </span>
                    <span>
                      {money(
                        products.find((p) => p.sku === l.sku)!.price *
                          l.quantity,
                      )}
                    </span>
                  </div>
                ))}
                <div className="grand">
                  <span>Total SGD</span>
                  <strong>{money(receipt.total)}</strong>
                </div>
                <div className="list-row">
                  <span>Cash received</span>
                  <span>{money(receipt.tender)}</span>
                </div>
                <div className="list-row">
                  <span>Change</span>
                  <span>{money(receipt.change)}</span>
                </div>
                <p className="footnote">SIMULATION ONLY · NOT A TAX INVOICE</p>
              </div>
              <div className="receipt-actions">
                <button onClick={() => window.print()}>Print receipt</button>
                <button
                  className="primary"
                  onClick={() => {
                    setModal(null);
                    setScreen("Sell");
                  }}
                >
                  New sale
                </button>
              </div>
            </>
          )}
          {modal === "reset" && (
            <>
              <p>
                Reset sample stock, your demo cart and the simulated receipts
                saved by this demo. Full application data is separate.
              </p>
              <button
                className="primary full"
                onClick={() => {
                  if (save(initial())) {
                    setModal(null);
                    setScreen("Sell");
                  }
                }}
              >
                Reset sample data
              </button>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StaticDemo />
  </React.StrictMode>,
);
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register(base + "sw.js", { scope: base })
    .catch(() => {
      // Selling simulation remains available online when browser caching is unavailable.
    });
}
