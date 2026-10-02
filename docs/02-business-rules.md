# 02 · Business rules and transaction invariants

> 中文重点：钱、库存、退款和同步必须一致。以下是本项目规则，不是税务或支付合规保证。

## Money and quantity

All monetary values are integers in the configured currency's minor unit. V1 admits two-decimal currencies only. JSON values are bounded safe integers: each nonnegative amount is at most 1,000,000,000 minor units; reject a document whose intermediate or final totals exceed this cap. Compute with integer/BigInt intermediates, never binary floating-point prices. Whole quantities are integers 1–999 per line; at most 100 lines per sale. Monetary aggregates and SQL storage use BIGINT; serializers validate the API range.

Use a stable line_id so the same product can appear at distinct approved prices. A duplicate tap normally increments the existing equivalent-price line. SKU, description, unit price, tax basis points and price revision are snapshotted on the sale line.

For each line: gross = quantity × unit_price_minor; net = gross − discount_minor. For exclusive tax, tax_minor = floor((net × tax_bps + 5000) / 10000), using integer half-up rounding for nonnegative net. Line total = net + tax. Sale gross, discount and tax are sums of line values; amount due = gross − discount + tax. No document-level discount, tax-inclusive prices, compound taxes, cash rounding or tips in V1.

Worked synthetic fixture: 2 cold brew × 450 + 1 oat cookies × 320 + 1 sparkling water × 180 = 1,400 minor units. Discount 0; tax disabled; due SGD 14.00. Cash tender 2,000; change 600; payment amount applied 1,400. Never treat the 2,000 tender as sales revenue. A separate artificial 500-bps example for calculation tests is not a regional tax recommendation.

## Sale and payment state

Cart states: DRAFT → PAYMENT_REVIEW → LOCAL_COMMITTED → SERVER_POSTED. Cancel is allowed only before LOCAL_COMMITTED. Sync state (pending/sending/acked/retry/needs_review) is separate from commercial state. A saved sale cannot return to a mutable cart. Local and server receipt identifiers may both exist; do not replace the underlying UUID.

V1 accepts exactly one payment row per sale. CASH stores applied amount, tender and change. CARD_MANUAL and PAYNOW_MANUAL store applied amount, operator verification time and a non-sensitive reference; tender equals applied amount, change is zero. They require the online workflow. The visible label is “Recorded externally”, not “Provider verified”. A QR graphic or customer screenshot alone is not verification. No PAN, CVV, card token or bank credentials are collected.

## Price changes and offline authorization

Cart pricing uses the last accepted catalogue version. Going to payment refreshes price availability when online; a changed price requires explicit review before receiving money. Once physical payment is taken and the local document commits, a later price update must not silently rewrite that sale.

The server validates online quoted prices or signed offline-permit limits against retained price revisions. Legitimate completed offline cash sales with older permitted prices are posted with their original amounts. Invalid signatures, unknown revisions or excessive discounts enter NEEDS_REVIEW; preserve the original payload and cashier receipt. Cash may already have changed hands, so never auto-delete or auto-charge again.

## Inventory invariant

A stock movement is the authoritative event; stock_balances is a rebuildable projection. Both movement insertion and balance change occur in the same database transaction as a posted sale or refund. Opening stock is a RECEIPT movement, not an unexplained product quantity. Types: RECEIPT (+), SALE (−), RETURN (+ if restockable), ADJUSTMENT (signed nonzero).

Draft and held carts do not reserve stock. The POS warns using the latest server balance plus unacknowledged local deltas. Do not apply the same local delta again after its sale is acknowledged. A new online sale is blocked before payment if insufficient stock is known. An authentic already-completed offline sale may create a negative balance on replay and an owner exception; rejecting reality would hide cash and stock movement. The owner resolves the discrepancy through a reasoned movement, not editing historical sales.

Adjustments require current balance_version, counted quantity or explicit delta, reason and actor. Conflicting counts return 409 and require a refresh/recount. Do not use a stale count to overwrite newer sales.

## Refunds

Refunds are manager-only, online, linked to a SERVER_POSTED original sale. Lock the original lines and cumulative returned quantities in a stable order. Refund quantity must not exceed remaining quantity; refund currency and tax treatment follow original snapshots. For rounding, refund the difference between cumulative entitled amounts before/after this refund; the final refund receives the remaining cents so total refunds equal—but never exceed—the original total.

Each refund line states restock=true/false. Resalable returns add stock; damaged returns do not. Refunding cash affects the currently open shift, not the original shift. Manual electronic refunds record an externally executed refund only after verification; there is no automatic money movement. An entire refund, its payment record, restock movements and audit event commit atomically. Use a stable refund UUID for retries. Posted sales/refunds cannot be deleted; cancellation before payment is not a refund.

## Shift and reporting

One open shift per store and terminal. Opening requires online authentication and a starting cash float. Expected drawer = opening float + CASH applied sale amounts − CASH refund amounts + cash-in − cash-out. Variance = actual cash count − expected drawer. Every nonzero variance needs a reason. The included dashboard sample shows gross 486.00, refunds 18.00, net 468.00 over 36 completed sales; average ticket = gross/36 = 13.50. Unsynced amounts are shown separately, never mixed into server-confirmed totals without a label.

Use the shift's server-assigned business_date in the configured timezone for sale reporting; client clock is evidence, not the authority. Recognize refunds on the current refund shift's business date. Store UTC timestamps plus business_date. Final shift close is online, requires no pending/review documents and a terminal reconciliation acknowledgement. Local cash-count drafts do not close the server shift.

## Audit and identity

Server derives store/role from authentication; never trusts a body shop_id. Enforce uniqueness for SKU, normalized barcode, client sale UUID and canonical receipt number within store. Use UUIDs for identity and a server sequence for receipt display; sequence gaps are acceptable and documented. Retain original actor/device, reason, UTC time, request ID and linked entities for every material action.
