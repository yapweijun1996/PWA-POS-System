# 13 · Future ERP integration without ERP dependence

> 中文重点：POS 自己可以运作，ERP adapter 以后再接；不要直接写 Globe3 table。

## Architectural seam

Define a separate adapter package, not ERP-specific fields throughout the cart. POS commits its own sale and inventory transaction first. A durable integration_outbox publishes `pos.sale.posted.v1`, `pos.refund.posted.v1` and selected stock events for asynchronous delivery. Checkout never waits for ERP availability.

No existing Globe3 schema, API permissions or posting rules were inspected for this kit. Any actual integration requires authorized discovery and review. Do not map arbitrary POS UUIDs into an ERP field based on a similar name.

## Mapping model

Maintain source_system + entity_type + external_id + pos_id mappings for product, location, tax code, currency and payment method. Version mapping changes and preserve the values used by historical events. An unresolved mapping sends the integration event to review; the local sale stays posted.

Decide stock authority before enabling two-way sync. For a future ERP-managed catalogue, ERP may own product/master pricing while POS owns sale capture; physical stock movement ownership must be explicit. Do not let both systems independently decrement the same sale and then import each other's decrement.

## Event envelope

`event_id`, `event_type`, `schema_version`, `store_id`, `occurred_at`, `sale_id` or `refund_id`, `currency`, immutable totals/lines, source references and correlation ID. Exclude cardholder data, secrets and unnecessary customer information. Sign/authenticate the transport appropriate to the receiving API.

Delivery is at least once; receiver deduplicates event_id. Record attempts, next_retry_at, error code and acknowledged external document ID. Separate transient availability errors from permanent mapping/validation errors. Replay uses the same event identity.

## Reconciliation

Daily compare POS posted sales/refunds with ERP acknowledgements by event ID and totals. Show pending, failed, duplicate-suppressed and reconciled counts. Corrections use an explicit compensating event; they do not rewrite a posted POS sale. Include a dry-run preview before enabling write operations.

## Expansion gates

Only add this adapter after the standalone cash/refund/offline flows pass. First prove product read mapping and sale export to a sandbox. Then verify currency/tax/payment mapping, inventory ownership and retry behavior. Production ERP writing requires separate authorization, secrets and rollback procedures.
