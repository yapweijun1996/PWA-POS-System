import { useEffect, useState, type FormEvent } from "react";
import type {
  Bootstrap,
  Product,
  Shift,
  SaleCommand,
} from "../../../packages/contracts/index.ts";
import {
  formatMoney,
  parseMoney,
  refundAllocation,
} from "../../../packages/domain/money.ts";
import { api } from "./api.ts";
import { db, meta, putMeta, hashPayload, type Outbox } from "./db.ts";
import { synchronize } from "./sync.ts";
import {
  savedCommands,
  saveAndSend,
  sendSavedCommand,
  requireNoSavedCommands,
  type SavedCommand,
} from "./commands.ts";
import { exportCsv } from "./export.ts";
import { restoreRecovery } from "./recovery.ts";
import { Dialog, Field, Empty, download } from "./components.tsx";
type Props = {
  screen: string;
  boot: Bootstrap;
  products: Product[];
  shift: Shift | null;
  online: boolean;
  writer: boolean;
  refresh: () => Promise<void>;
  error: (s: string) => void;
  outbox: Outbox[];
  openShift: () => void;
};
type SaleDetail = {
  id: string;
  receipt_no: string;
  total_minor: number;
  lines: (SaleCommand["lines"][number] & { id: string; returned: number })[];
  refunds: { id: string; total_minor: number; reason: string }[];
  payment: SaleCommand["payment"];
};
export function BackOffice(p: Props) {
  const [commands, setCommands] = useState<SavedCommand[]>([]);
  const [reviews, setReviews] = useState<Record<string, unknown>[]>([]),
    [recoveryFile, setRecoveryFile] = useState<File | null>(null),
    [recoveryMessage, setRecoveryMessage] = useState("");
  const [records, setRecords] = useState<Record<string, unknown>[]>([]),
    [categories, setCategories] = useState<{ id: string; name: string }[]>([]),
    [modal, setModal] = useState<string | null>(null),
    [selected, setSelected] = useState<Product | null>(null),
    [detail, setDetail] = useState<SaleDetail | null>(null),
    [busy, setBusy] = useState(false),
    [summary, setSummary] = useState<Record<string, unknown> | null>(null),
    [returns, setReturns] = useState<
      Record<string, { quantity: number; restock: boolean }>
    >({}),
    [stockQuantity, setStockQuantity] = useState("1"),
    [count, setCount] = useState(""),
    [why, setWhy] = useState(""),
    [search, setSearch] = useState(""),
    [passphrase, setPassphrase] = useState("");
  const money = (n: number) => formatMoney(n, p.boot.store.currency);
  const manage = p.boot.user.role === "MANAGER";
  async function load() {
    setCommands(await savedCommands());
    if (!p.online) return;
    if (p.screen === "Products") {
      const items: Product[] = [];
      let cursor: string | null = null;
      do {
        const page: { items: Product[]; next_cursor: string | null } =
          await api(
            "/products?archived=true&limit=100" +
              (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
          );
        items.push(...page.items);
        cursor = page.next_cursor;
        if (items.length > 100000)
          throw new Error("Catalogue exceeds supported bounds");
      } while (cursor);
      setRecords(items as unknown as Record<string, unknown>[]);
      setCategories(await api("/categories"));
    } else if (p.screen === "Inventory")
      setRecords(await api("/inventory/ledger"));
    else if (p.screen === "Sales")
      setRecords(await api("/sales?search=" + encodeURIComponent(search)));
    else if (p.screen === "Overview") setSummary(await api("/reports/daily"));
    else if (p.screen === "Sync center" && manage)
      setReviews(await api("/sync/review"));
    else if (p.screen === "Settings") setRecords(await api("/audit"));
  }
  useEffect(() => {
    void load().catch((e) => p.error(e.message));
  }, [p.screen, p.online, search]);
  useEffect(() => {
    void meta<{ count: string; reason: string }>("cash_count").then((v) => {
      if (v) {
        setCount(v.count);
        setWhy(v.reason);
      }
    });
  }, []);
  async function action(task: () => Promise<void>) {
    if (busy) return;
    if (!p.writer) {
      p.error(
        "This tab is read-only. Wait for the selling tab to release its lease.",
      );
      return;
    }
    setBusy(true);
    try {
      await task();
      await p.refresh();
      await load();
      setModal(null);
    } catch (e) {
      p.error((e as Error).message);
    } finally {
      setCommands(await savedCommands());
      setBusy(false);
    }
  }
  async function productSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await action(async () => {
      await api(
        "/products" + (selected ? "/" + selected.id : ""),
        {
          name: String(f.get("name")),
          sku: String(f.get("sku")),
          barcode: String(f.get("barcode")) || null,
          category_id: String(f.get("category")),
          unit_price_minor: parseMoney(String(f.get("price"))),
          cost_minor: parseMoney(String(f.get("cost"))),
          tax_bps: 0,
          low_stock_threshold: Number(f.get("threshold")),
          active: f.get("active") === "on",
          ...(selected ? { expected_version: selected.version } : {}),
        },
        {},
        selected ? "PATCH" : "POST",
      );
    });
  }
  async function stockSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await action(async () => {
      if (!selected) throw new Error("Choose a product");
      await requireNoSavedCommands();
      const next: SavedCommand = {
        key: "stock_command",
        actor_id: p.boot.user.id,
        path:
          "/inventory/" +
          (modal === "Receive stock" ? "receipts" : "adjustments"),
        body: {
          client_event_id: crypto.randomUUID(),
          product_id: selected.id,
          ...(modal === "Receive stock"
            ? { quantity: Number(f.get("quantity")) }
            : {
                counted_quantity: Number(f.get("quantity")),
                expected_version: selected.balance_version,
              }),
          reason: String(f.get("reason")),
        },
      };
      await saveAndSend(next);
    });
  }
  const returned = detail
    ? detail.lines.reduce((sum, line) => {
        const q = returns[line.id]?.quantity ?? 0;
        return (
          sum + (q ? refundAllocation(line, line.returned, q).total_minor : 0)
        );
      }, 0)
    : 0;
  async function refundSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await action(async () => {
      if (!detail || !p.shift) throw new Error("Open a shift before a refund");
      const id = crypto.randomUUID();
      const body = {
        client_refund_id: id,
        original_sale_id: detail.id,
        shift_id: p.shift.id,
        reason: String(f.get("reason")),
        method: detail.payment.method,
        ...(detail.payment.method === "CASH"
          ? {}
          : {
              external_reference: String(f.get("reference")),
              operator_verified_at: new Date().toISOString(),
            }),
        lines: detail.lines
          .filter((l) => returns[l.id]?.quantity)
          .map((l) => ({ original_sale_line_id: l.id, ...returns[l.id] })),
      };
      await saveAndSend({
        key: "refund_command",
        actor_id: p.boot.user.id,
        path: "/refunds",
        body,
      });
      setDetail(null);
    });
  }
  async function close() {
    await action(async () => {
      if (!p.shift) throw new Error("No open shift");
      await requireNoSavedCommands();
      await putMeta("cash_count", { count, reason: why });
      const amount = parseMoney(count);
      await api(`/shifts/${p.shift.id}/count`, {
        counted_minor: amount,
        reason: why,
      });
      const ids = (
        await db.sales.where("shift_id").equals(p.shift.id).toArray()
      ).map((s) => s.client_sale_id);
      const pending = await db.outbox
        .filter(
          (o) => o.payload.shift_id === p.shift!.id && o.state !== "ACKED",
        )
        .count();
      const ack = await api<{ reconciliation_id: string }>(
        `/shifts/${p.shift.id}/reconcile`,
        { device_id: p.shift.device_id, sale_ids: ids, pending_count: pending },
      );
      await api(`/shifts/${p.shift.id}/close`, {
        counted_minor: amount,
        reason: why,
        ...ack,
      });
      await db.meta.delete("shift");
      await db.meta.delete("permit");
      await db.meta.delete("cash_count");
    });
  }
  async function recovery() {
    await action(async () => {
      if (passphrase.length < 12)
        throw new Error("Use a passphrase of at least 12 characters");
      const docs = await db.outbox.toArray();
      const content = JSON.stringify({
        schema_version: 1,
        device_id: p.shift?.device_id,
        documents: docs,
        checksum: await hashPayload(docs),
      });
      const salt = crypto.getRandomValues(new Uint8Array(16)),
        iv = crypto.getRandomValues(new Uint8Array(12));
      const base = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(passphrase),
        "PBKDF2",
        false,
        ["deriveKey"],
      );
      const key = await crypto.subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt, iterations: 250000 },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"],
      );
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(content),
      );
      download(
        "counter-recovery.encrypted.json",
        new Blob(
          [
            JSON.stringify({
              version: 1,
              iterations: 250000,
              salt: Array.from(salt),
              iv: Array.from(iv),
              ciphertext: Array.from(new Uint8Array(ciphertext)),
            }),
          ],
          { type: "application/json" },
        ),
      );
      setPassphrase("");
    });
  }
  const disabled = !p.online || busy || !p.writer;
  return (
    <section className="admin">
      {manage && records.length > 0 && (
        <div className="export-action">
          <button
            onClick={() =>
              exportCsv(
                "counter-" +
                  p.screen.toLowerCase().replaceAll(" ", "-") +
                  ".csv",
                records,
              )
            }
          >
            Export shown rows (CSV)
          </button>
        </div>
      )}
      {!p.online && (
        <p className="notice">
          Offline. Administrative changes require the server. Cached catalogue
          and local receipts remain available.
        </p>
      )}
      {p.screen === "Products" && (
        <>
          <div className="section-head">
            <p>Catalogue details and immutable price revisions.</p>
            <div>
              <button
                disabled={disabled}
                onClick={() => {
                  setSelected(null);
                  setModal("New product");
                }}
              >
                + New product
              </button>
              <button
                disabled={disabled}
                onClick={() => setModal("New category")}
              >
                New category
              </button>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product / SKU</th>
                  <th>Price</th>
                  <th>Cost</th>
                  <th>Stock</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {records.map((row) => {
                  const r = row as unknown as Product;
                  return (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.name}</strong>
                        <br />
                        <small>{r.sku}</small>
                      </td>
                      <td>{money(r.unit_price_minor)}</td>
                      <td>{money(r.cost_minor ?? 0)}</td>
                      <td>{r.quantity}</td>
                      <td>{r.active ? "Active" : "Archived"}</td>
                      <td>
                        <button
                          disabled={disabled}
                          onClick={() => {
                            setSelected(r);
                            setModal("Edit product");
                          }}
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {p.screen === "Inventory" && (
        <>
          <div className="stock-grid">
            {p.products.map((r) => (
              <article className="stock-card" key={r.id}>
                <div>
                  <strong>{r.name}</strong>
                  <p>
                    {r.sku} · version {r.balance_version}
                  </p>
                </div>
                <strong
                  className={
                    r.quantity <= r.low_stock_threshold ? "warning" : ""
                  }
                >
                  {r.quantity} units
                </strong>
                <div>
                  <button
                    disabled={disabled}
                    onClick={() => {
                      setSelected(r);
                      setStockQuantity("1");
                      setModal("Receive stock");
                    }}
                  >
                    Receive
                  </button>
                  <button
                    disabled={disabled}
                    onClick={() => {
                      setSelected(r);
                      setStockQuantity(String(r.quantity));
                      setModal("Count adjustment");
                    }}
                  >
                    Count
                  </button>
                </div>
              </article>
            ))}
          </div>
          <h2>Stock ledger</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Product</th>
                  <th>Movement</th>
                  <th>Units</th>
                  <th>Reason / reference</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={String(r.id)}>
                    <td>{new Date(String(r.occurred_at)).toLocaleString()}</td>
                    <td>{String(r.name)}</td>
                    <td>{String(r.movement_type)}</td>
                    <td>{String(r.quantity_delta)}</td>
                    <td>{String(r.reason ?? r.reference)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {p.screen === "Sales" && (
        <>
          <label className="field">
            <span>Search receipt or sale UUID</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Receipt</th>
                  <th>Time</th>
                  <th>Method</th>
                  <th>Total</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={String(r.id)}>
                    <td>{String(r.receipt_no)}</td>
                    <td>{new Date(String(r.posted_at)).toLocaleString()}</td>
                    <td>
                      {String(r.method).replace(
                        "_MANUAL",
                        " · Recorded externally",
                      )}
                    </td>
                    <td>{money(Number(r.total_minor))}</td>
                    <td>
                      <button
                        disabled={!p.online}
                        onClick={() => {
                          void api<SaleDetail>("/sales/" + r.id)
                            .then((d) => {
                              setDetail(d);
                              setReturns({});
                              setModal("Sale detail");
                            })
                            .catch((e) => p.error(e.message));
                        }}
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!records.length && <Empty text="No server-posted sales yet." />}
          <h2>Saved on this device</h2>
          {p.outbox.map((o) => (
            <div className="list-row" key={o.id}>
              <span>
                {o.posted?.receipt_no ?? "Local · " + o.id.slice(0, 8)}
                <small>{o.state}</small>
              </span>
              <strong>{money(o.payload.total_minor)}</strong>
            </div>
          ))}
        </>
      )}
      {p.screen === "Overview" && (
        <>
          {summary ? (
            <>
              <p>
                Server-confirmed · {String(summary.business_date)}. Pending
                local amounts are excluded.
              </p>
              <div className="metrics">
                {[
                  ["Gross", summary.gross_minor],
                  ["Refunds", summary.refunds_minor],
                  ["Net", summary.net_minor],
                  ["Average ticket", summary.average_minor],
                ].map(([label, n]) => (
                  <article key={String(label)}>
                    <small>{String(label)}</small>
                    <strong>{money(Number(n))}</strong>
                  </article>
                ))}
                <article>
                  <small>Orders</small>
                  <strong>{String(summary.orders)}</strong>
                </article>
              </div>
              <h2>Low stock</h2>
              {(summary.low_stock as Product[]).map((p) => (
                <div key={p.id} className="list-row">
                  <strong>{p.name}</strong>
                  <span>{p.quantity} units</span>
                </div>
              ))}
            </>
          ) : (
            <Empty text="Connect to load the daily summary." />
          )}
        </>
      )}
      {p.screen === "Sync center" && (
        <>
          <div className="section-head">
            <p>
              Open Counter POS to finish syncing. Background Sync is optional.
            </p>
            <div>
              <button
                disabled={disabled}
                onClick={() => {
                  void action(async () => {
                    await synchronize(true);
                  });
                }}
              >
                Sync now
              </button>
              {manage && (
                <>
                  <button onClick={() => setModal("Encrypted recovery export")}>
                    Export recovery
                  </button>
                  <button onClick={() => setModal("Restore recovery package")}>
                    Restore recovery
                  </button>
                </>
              )}
            </div>
          </div>
          {commands.map((command) => (
            <article className="sync-card" key={command.key}>
              <div>
                <strong>
                  Saved {command.key.replace("_command", "")} request
                </strong>
                <p>
                  Confirmation is pending. Retrying keeps the original request
                  and identity.
                </p>
                <p>{String(command.body.reason ?? "")}</p>
              </div>
              <button
                disabled={disabled || command.actor_id !== p.boot.user.id}
                onClick={() =>
                  void action(async () => {
                    await sendSavedCommand(command, p.boot.user.id);
                  })
                }
              >
                Retry saved {command.key.replace("_command", "")} request
              </button>
            </article>
          ))}
          {recoveryMessage && <p role="status">{recoveryMessage}</p>}
          {manage &&
            reviews.map((r) => (
              <article className="sync-card" key={String(r.id)}>
                <div>
                  <strong>Server review · {String(r.reason_code)}</strong>
                  <p>{String(r.client_document_id)}</p>
                </div>
                <button
                  disabled={disabled}
                  onClick={() => {
                    setModal("Reconcile recovery case");
                    setSummary(r);
                  }}
                >
                  Review
                </button>
              </article>
            ))}
          {p.outbox.length ? (
            p.outbox.map((o) => (
              <article className="sync-card" key={o.id}>
                <div>
                  <strong>{o.posted?.receipt_no ?? o.id.slice(0, 8)}</strong>
                  <p>
                    {money(o.payload.total_minor)} ·{" "}
                    {new Date(o.created_at).toLocaleString()}
                  </p>
                  <code>{o.id}</code>
                </div>
                <div>
                  <span
                    className={"badge " + (o.state === "ACKED" ? "" : "amber")}
                  >
                    {o.state}
                  </span>
                  {o.last_error && (
                    <p>
                      {o.last_error} · {o.attempts} attempts
                    </p>
                  )}
                  {o.state === "NEEDS_REVIEW" && (
                    <p>Preserved for manager review. No automatic repost.</p>
                  )}
                </div>
              </article>
            ))
          ) : (
            <Empty text="No local transactions waiting to sync." />
          )}
        </>
      )}
      {p.screen === "Close shift" && (
        <div className="panel narrow">
          {p.shift ? (
            <>
              <h2>Count the drawer</h2>
              <p>Opening float: {money(p.shift.opening_float_minor)}</p>
              <div className="grand">
                <span>Expected cash</span>
                <strong>{money(p.shift.expected_cash_minor)}</strong>
              </div>
              <Field label="Actual cash (SGD)">
                <input
                  inputMode="decimal"
                  value={count}
                  onChange={(e) => {
                    setCount(e.target.value);
                    void putMeta("cash_count", {
                      count: e.target.value,
                      reason: why,
                    });
                  }}
                />
              </Field>
              <Field label="Variance reason">
                <textarea
                  value={why}
                  onChange={(e) => {
                    setWhy(e.target.value);
                    void putMeta("cash_count", {
                      count,
                      reason: e.target.value,
                    });
                  }}
                  maxLength={500}
                />
              </Field>
              <p className="notice">
                All documents must sync and terminal sale identities must
                reconcile before final close.
              </p>
              <button
                className="primary"
                disabled={
                  disabled ||
                  !count ||
                  p.outbox.some((o) => o.state !== "ACKED")
                }
                onClick={() => void close()}
              >
                Reconcile & close shift
              </button>
              <button
                disabled={disabled}
                onClick={() => setModal("Cash in / out")}
              >
                Cash in / out
              </button>
            </>
          ) : (
            <>
              <Empty text="No shift is open." />
              <button disabled={!p.online} onClick={p.openShift}>
                Open shift
              </button>
            </>
          )}
        </div>
      )}
      {p.screen === "Settings" && (
        <>
          <div className="panel">
            <h2>{p.boot.store.name}</h2>
            <p>
              Currency: {p.boot.store.currency} · Timezone:{" "}
              {p.boot.store.timezone} · Tax disabled
            </p>
            <p>
              One active terminal · One open shift · Offline cash permit: 12
              hours / 200 sales / no discounts.
            </p>
            <p>
              Browser storage is not a backup. Never clear storage while pending
              documents remain.
            </p>
            <p>
              Production setup, backups and recovery: see the repository
              runbooks. This workspace uses synthetic data.
            </p>
          </div>
          <h2>Audit trail</h2>
          {records.map((r, i) => (
            <div className="list-row" key={i}>
              <span>
                {String(r.action)}
                <small>{String(r.reason ?? r.subject_type)}</small>
              </span>
              <time>{new Date(String(r.occurred_at)).toLocaleString()}</time>
            </div>
          ))}
        </>
      )}
      {modal && (
        <Dialog
          title={modal}
          close={() => {
            if (!busy) setModal(null);
          }}
        >
          {["New product", "Edit product"].includes(modal) && (
            <form onSubmit={productSave}>
              <Field label="Product name">
                <input
                  name="name"
                  defaultValue={selected?.name}
                  maxLength={160}
                  required
                />
              </Field>
              <div className="two-fields">
                <Field label="SKU">
                  <input
                    name="sku"
                    defaultValue={selected?.sku}
                    maxLength={64}
                    required
                  />
                </Field>
                <Field label="Barcode">
                  <input
                    name="barcode"
                    defaultValue={selected?.barcode ?? ""}
                    maxLength={80}
                  />
                </Field>
              </div>
              <Field label="Category">
                <select
                  name="category"
                  defaultValue={selected?.category_id}
                  required
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="two-fields">
                <Field label="Price (SGD)">
                  <input
                    name="price"
                    inputMode="decimal"
                    defaultValue={(
                      (selected?.unit_price_minor ?? 0) / 100
                    ).toFixed(2)}
                    required
                  />
                </Field>
                <Field label="Cost (SGD)">
                  <input
                    name="cost"
                    inputMode="decimal"
                    defaultValue={((selected?.cost_minor ?? 0) / 100).toFixed(
                      2,
                    )}
                    required
                  />
                </Field>
              </div>
              <Field label="Low stock threshold">
                <input
                  name="threshold"
                  type="number"
                  min="0"
                  defaultValue={selected?.low_stock_threshold ?? 6}
                />
              </Field>
              <label className="check">
                <input
                  name="active"
                  type="checkbox"
                  defaultChecked={selected?.active ?? true}
                />
                Active product
              </label>
              <p>Opening stock is received separately. Tax is disabled.</p>
              <button className="primary" disabled={disabled}>
                Save product
              </button>
            </form>
          )}
          {modal === "New category" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const name = String(new FormData(e.currentTarget).get("name"));
                void action(async () => {
                  await api("/categories", { name });
                });
              }}
            >
              <Field label="Category name">
                <input name="name" maxLength={80} required />
              </Field>
              <button className="primary" disabled={disabled}>
                Create category
              </button>
            </form>
          )}
          {["Receive stock", "Count adjustment"].includes(modal) &&
            selected && (
              <form onSubmit={stockSave}>
                <h3>{selected.name}</h3>
                <p>
                  Current: {selected.quantity} · version{" "}
                  {selected.balance_version}
                </p>
                <Field
                  label={
                    modal === "Receive stock"
                      ? "Units received"
                      : "Physical counted units"
                  }
                >
                  <input
                    name="quantity"
                    type="number"
                    min={modal === "Receive stock" ? 1 : 0}
                    max="999999"
                    value={stockQuantity}
                    onChange={(e) => setStockQuantity(e.target.value)}
                    required
                  />
                </Field>
                <p>
                  Movement preview:{" "}
                  {modal === "Receive stock"
                    ? Number(stockQuantity || 0)
                    : Number(stockQuantity || 0) - selected.quantity}{" "}
                  units
                </p>
                <Field label="Reason">
                  <textarea name="reason" required maxLength={500} />
                </Field>
                <p>
                  A count posts the difference from the current balance. If
                  stock changes, refresh and recount.
                </p>
                <button className="primary" disabled={disabled}>
                  Post movement
                </button>
              </form>
            )}
          {modal === "Sale detail" && detail && (
            <>
              <div className="receipt">
                <h3>{detail.receipt_no}</h3>
                {detail.lines.map((l) => (
                  <div className="list-row" key={l.id}>
                    <span>
                      {l.quantity} × {l.name_snapshot}
                      <small>{l.returned} returned</small>
                    </span>
                    <strong>{money(l.line_total_minor)}</strong>
                  </div>
                ))}
                <div className="grand">
                  <span>Total</span>
                  <strong>{money(detail.total_minor)}</strong>
                </div>
                {detail.refunds.map((r) => (
                  <p key={r.id}>
                    Refund {money(r.total_minor)} · {r.reason}
                  </p>
                ))}
              </div>
              <button
                onClick={() => {
                  try {
                    window.print();
                  } catch {
                    p.error("Print failed. The sale remains posted.");
                  }
                }}
              >
                Print receipt
              </button>
              {manage && (
                <button
                  disabled={!p.online || !p.shift}
                  onClick={() => setModal("Return items")}
                >
                  Return items
                </button>
              )}
            </>
          )}
          {modal === "Return items" && detail && (
            <form onSubmit={refundSave}>
              {detail.lines
                .filter((l) => l.quantity > l.returned)
                .map((l) => (
                  <div key={l.id} className="return-line">
                    <strong>{l.name_snapshot}</strong>
                    <Field
                      label={`Return quantity · ${l.quantity - l.returned} remaining`}
                    >
                      <input
                        type="number"
                        min="0"
                        max={l.quantity - l.returned}
                        value={returns[l.id]?.quantity ?? 0}
                        onChange={(e) =>
                          setReturns({
                            ...returns,
                            [l.id]: {
                              restock: returns[l.id]?.restock ?? true,
                              quantity: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </Field>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={returns[l.id]?.restock ?? true}
                        onChange={(e) =>
                          setReturns({
                            ...returns,
                            [l.id]: {
                              quantity: returns[l.id]?.quantity ?? 0,
                              restock: e.target.checked,
                            },
                          })
                        }
                      />
                      Resalable: return to stock
                    </label>
                  </div>
                ))}
              <Field label="Reason">
                <textarea name="reason" required maxLength={500} />
              </Field>
              {detail.payment.method !== "CASH" && (
                <Field label="Externally executed refund reference">
                  <input name="reference" required maxLength={120} />
                </Field>
              )}
              <div className="grand">
                <span>
                  Refund{" "}
                  {detail.payment.method === "CASH"
                    ? "cash"
                    : "recorded externally"}
                </span>
                <strong>{money(returned)}</strong>
              </div>
              <button className="primary" disabled={disabled || !returned}>
                Confirm return
              </button>
            </form>
          )}
          {modal === "Cash in / out" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void action(async () => {
                  if (!p.shift) throw new Error("Open shift required");
                  await saveAndSend({
                    key: "cash_command",
                    actor_id: p.boot.user.id,
                    path: `/shifts/${p.shift.id}/cash-movements`,
                    body: {
                      client_event_id: crypto.randomUUID(),
                      amount_minor:
                        parseMoney(String(f.get("amount"))) *
                        (f.get("direction") === "out" ? -1 : 1),
                      reason: String(f.get("reason")),
                    },
                  });
                });
              }}
            >
              <Field label="Direction">
                <select name="direction">
                  <option value="in">Cash in</option>
                  <option value="out">Cash out</option>
                </select>
              </Field>
              <Field label="Amount (SGD)">
                <input name="amount" inputMode="decimal" required />
              </Field>
              <Field label="Reason">
                <textarea name="reason" required />
              </Field>
              <button className="primary" disabled={disabled}>
                Record cash movement
              </button>
            </form>
          )}
          {modal === "Restore recovery package" && (
            <>
              <p>
                Recovery preserves original UUIDs and validates encryption and
                checksums. Reauthenticate as the original operator before
                syncing.
              </p>
              <Field label="Encrypted recovery file">
                <input
                  type="file"
                  accept="application/json"
                  onChange={(e) => setRecoveryFile(e.target.files?.[0] ?? null)}
                />
              </Field>
              <Field label="Recovery passphrase">
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </Field>
              <button
                className="primary"
                disabled={busy || !recoveryFile || !passphrase}
                onClick={() =>
                  void action(async () => {
                    const count = await restoreRecovery(
                      recoveryFile!,
                      passphrase,
                    );
                    setRecoveryMessage(
                      `${count} documents validated; existing identities preserved.`,
                    );
                    setPassphrase("");
                  })
                }
              >
                Validate & restore
              </button>
            </>
          )}
          {modal === "Reconcile recovery case" && summary && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void action(async () => {
                  await api(`/sync/review/${summary.id}/resolve`, {
                    reason: String(f.get("reason")),
                    external_reference: String(f.get("reference")),
                  });
                });
              }}
            >
              <p>
                This rejected transaction remains preserved. Record the separate
                cash/stock reconciliation reference before resolving. This
                action does not post a sale or transfer money.
              </p>
              <Field label="Reconciliation reason">
                <textarea name="reason" required maxLength={500} />
              </Field>
              <Field label="External reconciliation reference">
                <input name="reference" required maxLength={120} />
              </Field>
              <button className="primary" disabled={disabled}>
                Record manager reconciliation
              </button>
            </form>
          )}
          {modal === "Encrypted recovery export" && (
            <>
              <p>
                This package contains business records. Keep the file and
                passphrase private. It preserves original UUIDs.
              </p>
              <Field label="Encryption passphrase (12+ characters)">
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
              <button
                className="primary"
                disabled={busy || passphrase.length < 12}
                onClick={() => void recovery()}
              >
                Export encrypted package
              </button>
            </>
          )}
        </Dialog>
      )}
    </section>
  );
}
