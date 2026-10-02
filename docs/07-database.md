# 07 · Database model and persistence contract

> 中文重点：SQL 是可评审的 reference schema；真正应用还需要 transaction service、权限和 migration 测试。

## Schema authority

`specs/schema.sql` is the proposed PostgreSQL relational baseline. It is not an applied migration against the user's data. The SQL includes types, keys, tenant-safe composite references, indexes and selected immutability guards. Cross-row financial invariants are enforced by the application posting service and integration tests; a CHECK constraint cannot validate sums across arbitrary child rows by itself.

## Entities and ownership

| Entity | Purpose | Key relationship |
|---|---|---|
| stores | Currency/timezone and receipt sequence owner | Deployment-level root |
| users | Named operator and role | Store-scoped, no seed password |
| devices | Registered terminal identity and revocation | Store-scoped |
| categories / products | Catalogue, SKU/barcode, current price revision | Store-scoped |
| product_prices | Immutable pricing/tax revisions | Product and catalogue version |
| shifts | Opening cash, business date, closed state and count | User + terminal |
| offline_permits | Signed authorization metadata and validity | Shift + terminal + user |
| sales / sale_lines | Posted transaction and historical item snapshot | Shift + unique client UUID |
| payments | One applied tender per V1 sale | Sale; method/verification boundary |
| refunds / refund_lines | Separate linked return and historical allocation | Original sale and line |
| refund_payments | Actual refund method record | Refund + current shift |
| stock_balances | Transactionally maintained, rebuildable quantity | Product + store |
| stock_movements | Immutable quantity event with concrete origin | Sale line / refund line / admin event |
| cash_movements | Signed non-sales cash in/out | Current shift |
| audit_events | Append-only actor/action/request evidence | Store + subject |
| integration_outbox | Post-commit delivery state for future adapter | Store + unique event ID |

## Key constraints

All child references carrying store_id use composite foreign keys against `(store_id,id)` so an API bug cannot accidentally attach one store's sale to another store's product. Server auth remains the first boundary. SKU and barcode normalization rules are identical at import, API and database boundaries. Empty barcode becomes NULL. Products referenced by history are archived, not physically deleted.

Sales use UUID primary keys and a separate `(store_id,client_sale_id)` uniqueness rule. Receipt numbers are server allocated and unique per store; UUID is the identity. The receipt sequence is monotonic but not promised gapless. Refund idempotency has the same permanent UUID principle.

Store timestamp fields as TIMESTAMPTZ, business dates as DATE and money as BIGINT. Clamp API values before conversion to JS numbers. Whole-unit quantity constraints apply to V1. Balance may become negative only through documented completed-offline-sale replay; the database permits this while the service records the exception.

## Snapshot rules

A line contains product_id and price_revision_id for lineage plus sku_snapshot, name_snapshot, unit_price_minor, discount_minor, tax_bps, tax_minor and line_total_minor. Editing today's name or price does not change last month's receipt. Product cost is not part of a cashier bootstrap and is not displayed on receipts.

Preserve the accepted document's canonical hash with each sale. Store raw reviewed/quarantined sync documents in a separately access-controlled recovery store during implementation; do not turn malformed payloads into posted sales.

## Posting and refund transactions

For a sale, validate all row sums before commit and use stable row lock ordering. The invariant is `sales.total = sum(lines.total) = payment.amount_applied`; cash tender − change = payment amount. SALE movement quantity equals the negative sold quantity exactly once. For a refund, validate cumulative returned quantity/amount while original lines are locked; RETURN movement exists only for restock=true.

Stock movements and the balance projection update in the same transaction. Application roles cannot UPDATE/DELETE posted history. Adjustment corrections are compensating events. For ordinary product updates, use version preconditions to avoid lost updates.

## Index plan

Indexes cover normalized active SKU/barcode, product category/active, sale shift/business date, sale creation cursor, original-sale refund lookup, stock product/time, unresolved outbox state and audit subject/time. Explain every additional index with an actual query. Do not index all JSON fields by default or perform a ledger SUM for every product card.

## Reconciliation queries

At backup/restore or maintenance, compare stock_balances to movement sums grouped by store/product; compare sale totals with line and payment sums; compare refunded quantity and amount with original entitlements; verify no cross-store join and no orphaned price revision. All discrepancies generate review output; never silently overwrite the ledger to match a projection.

## Migration and seed policy

Use versioned, reviewed forward migrations plus an explicit rollback/restore strategy. Do not auto-run destructive SQL on startup. Test an empty database and one upgraded from the previous release. Production admin creation is an interactive/secret-managed operation; the fixtures contain synthetic products only. The SQL does not include known passwords, public admin credentials or grant scripts that weaken production access.

## Deliberate omissions

No financial GL, purchase order, payable, customer-credit balance, item serial/batch, unit conversion, lot valuation or reservation model in V1. ERP mapping remains an adapter concern. Do not reinterpret a stock receipt as a supplier invoice.
