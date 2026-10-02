# 06 · Offline capability and synchronization protocol

> 中文重点：只有成功写入本机 transaction 后才显示“已保存”；只有服务器确认后才显示“已同步”。

## Capability matrix

| Operation | Online | Offline after readiness |
|---|---|---|
| Launch cached app / browse downloaded products | Yes | Yes |
| First login, enroll device, open a new shift | Yes | No |
| Edit/hold local cart | Yes | Yes |
| Cash sale under valid shift/permit | Yes | Yes |
| Record Card / PayNow external payment | Yes | No |
| Product price edit / receive / adjust inventory | Yes | No |
| Refund, final close, restore backup | Yes | No |
| View locally saved receipt | Yes | Yes, visibly local |
| Server-wide analytics | Yes | Last snapshot only, labeled stale |
| Stage a cash-count draft | Yes | Yes; does not close shift |

## Readiness and permit

Before going offline, complete login, terminal enrollment, catalogue download, open shift and a local write/read self-test. Download a server-signed offline permit scoped to store, user, terminal, shift, catalogue price revisions, allowed methods and discount ceiling. Proposed validity is at most 12 hours and 200 cash sales per permit; these are conservative planning limits to validate with the owner, not platform requirements.

The permit is not an API authentication bearer. Normal reauthenticated session credentials are still needed to upload. Offline unlock cannot securely replace server authentication. Clock rollback/restart can weaken expiry checks; use last trusted server time plus monotonic elapsed time while running, and block new offline sales after a restart when the permit's remaining validity cannot be established conservatively. Cached drafts remain readable. Revocation cannot take effect on a disconnected terminal immediately; document this residual risk.

## Local stores and atomic commit

IndexedDB stores: catalogue, price_revisions, shifts, permits, held_carts, local_sales, local_sale_lines, local_payments, local_stock_deltas, outbox, sync_meta. Persist no passwords, PAN/CVV or ordinary API tokens. IndexedDB supports transactional structured storage; application-level boundaries still need explicit design and tests. [S05]

When the cashier confirms cash received, generate sale and line UUIDs once. In a single IndexedDB readwrite transaction, write the frozen sale/lines/payment, matching pending stock deltas and outbox document; remove the mutable cart. Resolve success only after the transaction completes. If quota, serialization or transaction errors occur, abort and show “Sale not saved”. Never clear the cart first. Normal browser durability is not a guarantee against device loss, storage clearing or all power-loss scenarios. [S04]

## Outbox contract

Each item has event_id, client_sale_id, schema_version, canonical_payload_hash, frozen payload, created_at, attempts, next_retry_at, state and last_error. States: PENDING → SENDING → ACKED; transient failures become RETRY; permanent/conflicting or permission issues become NEEDS_REVIEW or AUTH_REQUIRED. SENDING leases expire on crash so the exact payload is retried.

Only one tab owns a renewable writer/sync lease, acquired by an atomic IndexedDB compare-and-set transaction with owner and expiry. A second tab is read-only until the lease can safely be claimed. BroadcastChannel/Web Locks may improve coordination when available; server idempotency remains required even with perfect local coordination.

## Push protocol

Send one bounded sale document per POST `/api/v1/sales`, with Idempotency-Key equal to client_sale_id. The API derives store identity, canonicalizes allowed fields and computes its own hash. Same identity + same hash returns the original posted outcome; same identity + different hash returns 409 IDEMPOTENCY_CONFLICT. Never trust the client-supplied hash alone.

On acknowledgement, update receipt mapping and outbox state in one local transaction. Reconcile the stock watermark: replace the cached server balance at the returned cursor and apply only local deltas absent from that cursor/acknowledged set. A plain “subtract after sync” produces double deductions. Retain acknowledged local sales until a verified backup/retention policy allows pruning; do not clear them on every version update.

Batching is optional later. If added, each sale remains atomic with a separate result; a partial batch cannot be reported as all successful.

## Pull protocol

GET catalogue snapshot/delta uses an opaque cursor, immutable price revisions and archive tombstones. Apply each received page transactionally. Record the next cursor only after the page commits. Expired cursor requires a full bootstrap that replaces catalogue state but leaves local sales/outbox intact. Snapshot switch happens between transactions, not halfway through payment review.

## Retry and connectivity

Retry on foreground launch, window focus/visibility, online event followed by a real health probe, manual Sync and an active-app timer. Use exponential backoff with jitter, capped at 60 seconds, respecting Retry-After. Distinguish connectivity, 401, 403, 409/422 and 5xx. A browser online flag alone does not establish server reachability.

Background Sync is an optional enhancement because its browser availability is limited. Do not promise sync while the app is closed or the OS suspends it. [S03] The customer-visible fallback is “Open Counter POS to finish syncing”.

## Conflict policy

Price change after local completion: post valid historical snapshot and flag only when outside permit. Insufficient current stock: post authentic offline sale with negative-stock exception rather than hiding a completed transaction. Revoked/unknown actor, unknown product revision or modified payload: preserve quarantine evidence and require manager review. Closed shift: stop and reconcile; do not silently move cash into today's shift.

Manual recovery export contains schema version, checksums, terminal identity and pending documents; it contains business data, so restrict to managers, warn about sensitivity and prefer encryption. Restore validates checksums and deduplicates by original UUID; never creates new sale identities.

## Service worker updates and migrations

Use versioned static cache names and fresh HTML/worker headers. Show waiting update and explicit Update now. Defer activation during payment, nonempty outbox or an incompatible local schema migration. Show an updating overlay, activate once, wait for controller change and reload. Retain at least one compatible rollback build and test N→N+1 with pending data. House-standard source: [K01]; platform update behavior: [S02].

## Offline release blockers

No launch/readiness test, dropped local sale, duplicate server stock movement, unsupported browser assumption, automatic refresh during payment, unbounded retries, negative stock without an exception, offline electronic payment presented as verified, or silent local-data deletion are release blockers.
