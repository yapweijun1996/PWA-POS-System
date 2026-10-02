# ADR 001: Local V1 implementation baseline

Status: historical local baseline from 2 October 2026. [ADR 002](002-production-hardening.md) supersedes affected account, stock snapshot, recovery, migration and operations decisions. This is not approval for deployment, payments, an ERP connection, a license or a pilot shop.

The request to finish the project following its Markdown authorizes the V1 scope in `prompts/IMPLEMENTATION-TASK.md`. The existing design kit is retained as historical design evidence. The application lives in `apps/`, shared pure rules in `packages/`, reviewed migrations in `infra/migrations/`, and actual verification in `docs/qa/`.

## Runtime and exact dependencies

Node 24.19.0, PostgreSQL 16, React 19.3.0, Vite 8.3.2, Fastify 5.12.5, Dexie 4.4.6, TypeScript 5.9.3, pg 8.23.1 and Zod 4.6.5. The complete versions and integrity hashes are pinned in `package-lock.json`; `npm ci` is the installation contract. TypeScript 5.9 is intentionally kept while the other packages are verified together with Node 24. No ORM, component framework, cloud service or payment SDK is used.

Compatibility was checked against the [Node release policy](https://nodejs.org/en/about/previous-releases), [Vite runtime requirements](https://vite.dev/guide/), [Fastify v5 migration requirements](https://fastify.dev/docs/v5.6.x/Guides/Migration-Guide-V5/) and [Dexie transaction behavior](https://dexie.org/docs/Dexie/Dexie.transaction()). PostgreSQL was available locally, so a private loopback cluster is used for disposable development data without provisioning infrastructure.

## Decisions and contract clarifications

- Counter POS remains a working name; no software license or public brand approval is invented.
- SGD/MYR use two decimal places; tax is disabled throughout this release. Arbitrary exclusive tax is covered by pure tests, not offered as a legal configuration UI.
- Cashier discounts are zero. Managers may discount an online line up to its gross amount. Offline permits allow zero discounts, at most 12 hours and 200 sales.
- All sales first commit to IndexedDB. The API remains authoritative. Local storage failure preserves the draft; server rejection preserves the completed document for review.
- Product-price revisions additionally snapshot the name and SKU. This makes historical offline verification independent of later product edits.
- PostgreSQL requires UPDATE privileges for row locks. Runtime has UPDATE on only the identity column of sales/lines; immutable triggers reject every actual historical UPDATE/DELETE. Other historical tables have no UPDATE/DELETE grants. Runtime is a non-owner role.
- Stock commands use a stable `client_event_id` and canonical hash. Cash in/out uses a stable UUID and verifies the original shift/operator/amount/reason on replay, including after shift closure. Browser refund/stock/cash commands persist their frozen identity and operator before sending. Uncertain results survive reload and appear in Sync center for explicit retry by the original operator; a new command and final close wait for confirmation.
- Online documents are registered during sync, before posting. Reconciliation checks registered IDs, all posted sale IDs, unresolved quarantine and negative balances. A browser can still withhold an unseen offline document; the one-terminal reconciliation protocol is a declared trust boundary, not proof against a malicious cashier.
- Reconciliation tokens bind sale identities. Close recomputes the complete expected drawer inside the shift lock, so a later cash/refund event cannot cause stale monetary totals.
- Catalogue sync performs a paginated full snapshot with archive tombstones rather than an optimized delta stream. A revision change aborts the download. The completed snapshot is applied atomically without removing sales/outbox. Only ACKs captured before the snapshot request have their local stock deltas removed.
- Product management follows every bounded product continuation so products beyond the first hundred remain editable. Product continuations use opaque offset cursors. Sales/ledger accept bounded continuation offsets/cursors. The UI explicitly exports only shown rows. This is a small catalogue implementation; it does not claim optimized large historical cursor pagination.
- An offline reload preserves receipts and outbox but cannot establish permit time safely. It blocks new offline sales until online time is verified. A new page waits up to the old ten-second lease expiry; acquiring the writer lease triggers foreground sync.
- No Background Sync API is required or registered. Startup, focus, online event, a fifteen-second active timer and manual sync provide retries with bounded network timeouts/backoff.
- Service worker caches only shell/icons/original product illustrations and immutable assets. It never caches API/auth data or replays POSTs. Updates wait for explicit confirmation and an empty draft/outbox; activation displays an overlay. Two shell caches are retained for compatible rollback.
- Native HTML dialogs provide focus trapping. Focus returns to the payment trigger. POS controls remain fixed; the long-page scroll-to-top action replaces a hide/reveal header because status and transaction controls must remain visible (ADR-12).
- Recovery uses AES-GCM with PBKDF2-derived keys. Imports validate the original UUIDs, schema and checksums atomically. Quarantine resolution records an external reconciliation reason/reference and retains the original payload; it neither posts a sale nor transfers cash.
- The encrypted backup test uses an ephemeral RSA key entirely in memory, restores into a newly named isolated database, compares identities/rows and financial/stock reconciliations, and destroys its own temporary artifacts. It is a rehearsal, not a retained operational backup.

## Migration and rollback

Five ordered forward migrations add the reference schema, sessions/projections, least-privilege grants, historical row-lock permissions and recovery controls. Migration SQL and its version entry commit in one transaction under a migration lock. Startup never migrates production data. Restore a verified backup into a separate environment for rollback; never drop live tables or clear IndexedDB. Client schema V1 is retained. The service-worker upgrade test changes the real worker bytes while preserving pending documents.

## Delivery limits

No hardware barcode scanner, thermal printer, real iPhone standalone mode, Android hardware, production HTTPS, penetration test, CI remote run or deployment is claimed. Chromium browser automation and simulated safe-area/reflow tests do not certify physical-device behavior. ERP remains a durable event seam, without a delivery worker or credentials. Physical checks and business retention/brand/license decisions precede a pilot/public release.
