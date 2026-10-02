# 03 · Screens, interaction and responsive behavior

> 中文重点：收银页面以最快完成销售为主；后台才展示管理字段。

## Navigation and layout

Primary destinations: Sell, Products, Inventory, Sales, Overview. Shift and Sync are persistent utilities; Settings is manager-only. The desktop side rail includes labels, not unexplained icons. At 1024px and above, keep a 360–400px order panel and a flexible product grid. At 768–1023px, use a compact labeled rail and 320px cart when space permits. Below 768px, show a two-column product grid and a fixed “View order · total” action; cart and payment become full-screen sheets.

The POS header stays visible: an explicit exception to the house standard's hide-on-scroll default because scan/search, connectivity and cashier context are transaction controls. Product lists and long back-office pages may use a hide/reveal header if it does not hide critical status. Respect device safe areas and browser zoom. Never set user-scalable=no.

## Screen inventory

| ID | Screen | Content and actions | Important states |
|---|---|---|---|
| UI-01 | Sign-in / open shift | Account sign-in, device identity, opening float | Expired session, offline first launch, occupied terminal |
| UI-02 | Sell | Search/scan, category chips, product grid, cart, fixed total | Ready, loading, no results, stale catalogue, sold out |
| UI-03 | Mobile order | Full line descriptions, quantity controls, remove/undo, total | Empty, stock warning, insufficient permission |
| UI-04 | Payment | Due, method, numeric tender, change, explicit confirm | Underpaid, duplicate click disabled, local save failed |
| UI-05 | Receipt | Snapshot lines, local/canonical ID, applied/tender/change, print | Saved locally, synced, print failed, reprint |
| UI-06 | Products | Search, category/status filters, SKU/price/stock, editor drawer | Validation conflict, archive instead of delete |
| UI-07 | Inventory | On-hand, ledger, receive/adjust panel, version and reason | Stale count, negative-stock exception |
| UI-08 | Sales / return | Receipt search, date range, method, detail, manager refund | Local-only sale, already refunded, reference unavailable |
| UI-09 | Overview | Gross/refund/net/orders, top items, low stock, sync disclosure | No sales, delayed data, mixed business dates |
| UI-10 | Sync center | Pending/acked/retry/review, last attempt, recovery actions | Authentication needed, conflict, server unavailable |
| UI-11 | Close shift | Expected cash, actual count, difference, reason | Pending sync blocker, count draft, manager review |
| UI-12 | Settings / updates | Store, currency/tax, device, backup help, build update | Update waiting, checkout busy, migration blocked |

## Product selection and cart

Search by normalized product name, SKU and exact barcode. A keyboard-wedge scanner is the baseline input device; camera scanning is a later capability requiring camera permission and device tests. Preserve keyboard focus; do not capture scanner-like typing while a text or money input is active. Unknown barcodes show “Product not found” with search; do not silently create products.

A product card displays its image or initial, name, price and stock hint. Images are secondary to names. Tap increments quantity and briefly confirms the addition without opening a dialog. Quantity actions have a 44px target; disable minus at the minimum or turn it into explicit remove. Remove offers a short Undo action before checkout. A price override is not an ordinary cashier action.

Held carts remain on the current device and make no stock reservation. Restore refreshes pricing before payment. “Clear order” confirms if nonempty. There is no customer form in the primary flow; anonymous walk-in is the default.

## Payment and receipt interaction

Payment is a focused task, not another full admin page. Show amount due once at large size, available methods with explanatory text, tender input and change. Underpayment disables confirmation. Enter submits only when the focused form is valid and the user has reviewed the amount; shortcuts must not accidentally finalize a sale while scanning.

After confirmation, disable repeat submission, persist the local document atomically and only then display success. “Saved on this device — waiting to sync” uses an amber status and does not imply server acknowledgement. An online acknowledged sale displays the canonical receipt and “Synced”. If saving fails, keep the order, tell the cashier that nothing was saved, and stop the handover flow.

Printing opens browser print as the V1 baseline. A reprint must not create a new sale. Printer failure does not roll back an already accepted sale. 80mm receipt CSS is proposed; physical thermal printer fit, cash drawers and silent printing are not certified by a browser preview.

## Back office and errors

Products editor: name, SKU, barcode, category, price, cost, low-stock threshold, active. Explain duplicate field errors inline and preserve input. Create product does not receive stock. Inventory adjustment shows current quantity, counted quantity, computed delta and mandatory reason before posting.

A refund form lists remaining returnable quantity and restock choice per original line. Show the final refund amount before external refund/cash handover. A read-only sale detail must still expose useful history to cashiers without refund permission.

Sync errors use plain language plus expandable technical details. Recovery never offers “Delete pending sale”. Provide retry, reauthenticate, export recovery package and contact manager. Product/stock administration stays disabled offline with the reason adjacent to the action.

## Accessibility and microcopy

Use semantic buttons, dialogs and headings; label icon-only controls; trap and restore dialog focus; expose important status through aria-live without announcing every total change repeatedly. Respect reduced motion. Design target is WCAG 2.2 AA, not an asserted audit result. The 44px house touch target is stricter than WCAG 2.2's 24px minimum-target rule with exceptions. [S07]

Preferred words: “Take payment”, “Cash received”, “Change”, “Saved on this device”, “Waiting to sync”, “Recorded externally”, “Return items”, “Close shift”. Avoid “Success” for a server write that has not happened. Language switches must not change money, IDs or receipt snapshots.
