# Configurable tax design spec (SG GST / MY SST)

Status: DRAFT, no API/UI code written. Drafted by the pi coding agent (read-only), reviewed 2026-10-07. Scope widened 2026-10-07: owner goal is market-standard parity ("what other POS products have, we should have too").

## Owner decisions (confirmed 2026-10-07)

- Direction: standardise to market parity (StoreHub / Qashier / Square-class SME POS). Counter POS is no longer deliberately narrow.
- Singapore new store: default `inclusive`, GST 9%.
- Malaysia new store: no default; the owner must choose the mode and tax codes at setup.
- 5-cent cash rounding: cash only. Now part of Batch 1, but only after the cash-reconciliation design in "Parity batch 1" is agreed.
- Parity feature list below is the owner-approved batching; the competitor feature list is from general market knowledge and not yet verified vendor by vendor.

## Review notes

- Worked examples 1 to 3 below were hand-checked and are correct.
- Example 4 had no numbers. Replacement (SG inclusive, 3 units at S$3.33 = S$9.99 line): line base 917, GST 82. Refunding one unit at a time allocates cumulative shares, giving 306+27, 305+28, 306+27 cents (each S$3.33), which sum to the original S$9.99.
- Concern: keeping 5-cent rounding out of the posted sale conflicts with V1's one payment row per sale and with cash reconciliation. Decide how a rounded cash tender is recorded before building it.
- Concern: binding the offline permit to the tax configuration version is UNVERIFIED in the current code; read `apps/api` permit code first.

---

## 1. Current state

- `docs/tax-sg-my.md` describes the SG/MY requirements and flags legal/tax details needing verification. V1 is tax-off by default, with optional exclusive tax.
- `docs/01-product-requirements.md` says tax is off in sample data; tax treatment must be verified by the owner.
- `packages/domain/money.ts` calculates exclusive tax per line with integer half-up rounding. `saleMoney` sums line totals; `refundAllocation` allocates cumulative net and tax amounts to avoid refund drift.
- `specs/schema.sql` (also `infra/migrations/001-core.sql`) stores `tax_bps` and `tax_minor` per sale line, but no tax mode, tax code/label snapshots, or tax breakdown table is shown. `product_prices` stores a tax rate; products do not.
- `apps/api/src/sales.ts` validates submitted line and sale totals against `saleMoney`. `apps/api/src/refunds.ts` locks original sale lines and allocates refunds using their stored tax rate.
- `apps/api/src/` is the API implementation; `apps/pages/src/main.tsx` imports `saleMoney` and `formatMoney`. Receipt rendering location: **UNVERIFIED** from inspected files. Existing code confirms SGD/MYR formatting in `formatMoney`, but not receipt tax display.
- `tests/unit/money.test.ts` covers exclusive half-up rounding and cumulative refund allocation. E2E totals/receipt coverage locations are **UNVERIFIED**.

## 2. Data model and migration

Add store settings: `tax_mode` (`off|exclusive|inclusive`) and configurable default tax label. Add a `tax_codes` table scoped to store, with stable code, label, `rate_bps`, active flag, and effective/version metadata. Products/prices reference a tax code; retain `product_prices.tax_bps` during transition.

At sale posting, snapshot the mode, tax code, label, rate, and price basis on each `sale_lines` row. Add explicit `net_minor`, and define `unit_price_minor` as entered shelf/unit price. Add immutable per-sale/per-tax-code breakdown rows (code/label/rate snapshots, taxable base, tax amount), plus receipt-level mode/label snapshot on `sales`. Refund lines should snapshot the original tax identity and allocated base/tax; refund breakdown aggregates those allocations.

Use a new additive migration; backfill existing sales/lines with their recorded `tax_bps`, zero tax label/code as “legacy/unknown,” and treat old sales as exclusive only where that interpretation is supported. Do not recalculate posted history. Existing records’ exact semantic interpretation is **UNVERIFIED**; preserve their original totals and mark legacy snapshots.

## 3. Calculation rules and examples

Use integer minor units, nonnegative amounts, half-up rounding. Discount reduces taxable base. For inclusive tax, base = round-half-up(price × 10000 / (10000 + rate)); tax = price − base. Exclusive tax = round-half-up(base × rate / 10000). Tax per line, then sum by code for the receipt. This matches existing code’s line-level rounding and avoids basket-dependent changes. No compound taxes in this scope.

Examples (single quantity, no discount; currency shown in major units):

1. **SG inclusive GST 9%:** shelf S$10.00 = 1000 cents; base 917 cents, GST 83 cents; due S$10.00.
2. **SG exclusive GST 9%:** base S$10.00; GST 90 cents; due S$10.90.
3. **MY exclusive sales tax 10%:** base RM10.00; tax RM1.00; due RM11.00.
4. **MY service tax 8% exclusive, partial refund:** RM10.00 base, RM0.80 tax, RM10.80 due. Refund one unit of a two-unit line: allocate cumulative original net/tax proportionally; final refund(s) must sum exactly to the original line’s RM10.80. Exact per-refund cents depend on original line quantity/rounding allocation.

Recommend **no cash rounding in the tax engine or posted sale**; show an optional cash-tender adjustment to nearest 5 cents only after tax, separately recorded and mirrored on cash refund. This preserves exact item/tax values and makes noncash totals unaffected. Whether this is legally/operationally desired is **UNVERIFIED**.

## 4. API, offline, idempotency

Server validates mode, code, rate and all derived amounts; client-submitted totals are never authoritative. Include immutable snapshots in canonical sale payload/hash. Server-signed offline permits bind a deterministic tax-configuration fingerprint (mode and product rates); stale local configuration must disable offline sales. **Implemented on branch, not e2e-tested.** Offline catalogue and local sale/outbox must persist the same price/tax snapshots atomically. Stable UUID/hash retries remain idempotent; changed tax snapshots under the same key return conflict.

## 5. UI

Owner settings: mode and tax-code management; product editor: assign code, label/rate visibility. Sell screen replaces “Tax off” with active mode and clearly displays tax-inclusive/exclusive pricing. Receipt shows line tax and grouped tax totals, correct jurisdiction label, and inclusive-price statement where required. Refund view shows original tax allocation.

## Parity batch 1 (tax and payments)

Build order matters because each step changes the schema or the posted-sale contract:

1. Tax mode, tax codes and per-line snapshots (this spec, sections 2 to 5).
2. Payment methods as a configurable list: Cash, Card, PayNow, DuitNow. Card and QR are recorded manually; no terminal integration in this batch.
3. Split tender: replaces V1's one payment row per sale with `sale_payments` (many rows per sale). Rule: sum of payments = sale total (or total + cash rounding adjustment). Refunds must say which payment method is returned.
4. 5-cent cash rounding (cash tender only): store the rounding adjustment as its own signed field so total and tax stay untouched. Open point: how a rounded cash payment reconciles with the shift cash count.
5. Service charge (percentage line on the sale). Open point for the accountant: whether it is taxed (SG GST normally applies; MY service tax rules differ). Do not guess; make it configurable per store.

Steps 3 and 4 touch the immutable-history triggers and the offline permit contract, so each needs its own migration and e2e. Check the offline permit code before step 1 is finished.

## 6. Tests to add

**Unit:** inclusive/exclusive calculations, zero/off mode, mixed codes, discounts, boundary rates, half-cent rounding, line-vs-receipt divergence, 5-cent adjustment, and partial/final refunds retaining original snapshots.

**Integration/E2E:** migration preserves old totals; mixed-rate sale and receipt; inclusive SG and exclusive MY flows; offline signed-permit sale/retry and stale-config rejection; identical retry versus changed payload; partial refund sequence equals original amount/tax; cash rounding only affects cash tender.

## 7. Risks and out of scope

Tax eligibility, rates, inclusive-price obligations, receipt wording, rounding and retention require jurisdictional/accounting review; research notes are not legal advice. E-invoicing (MyInvois, InvoiceNow), fiscalisation, compound taxes and tax exports are out of scope for Batch 1. Service charge and split tender moved into Batch 1 (see "Parity batch 1").

## 8. Owner questions (remaining)

- Default mode for new SG and MY stores?
- Which MY goods/services and rates apply, and may a shop mix tax types?
- Is MY shelf pricing inclusive or exclusive?
- Should 5-cent rounding apply only to cash, and how should refunds handle prior rounded tenders?
- How should existing tax-enabled sales with no tax label be presented?
- Confirm receipt wording and whether tax configuration changes require an online-only boundary.
