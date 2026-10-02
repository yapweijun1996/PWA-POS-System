# ADR 002: Production hardening and deployment contract

Status: implemented for the single-store application on 3 October 2026. Executed results and outstanding release gates are recorded in `docs/qa/REPORT.md`. This supersedes affected local-only decisions in ADR 001 and preserves its financial/offline limits.

## Accounts and configuration

Settings supports operator creation, access changes, manager password resets, self-service password changes and other-session revocation. New passwords use asynchronous scrypt; legacy hashes remain verifiable. Versioned, domain-separated HMAC sessions ensure password/access changes invalidate old sessions. Subsequent requests recheck activity/account version; an already admitted request may finish.

Migration 006 invalidates old sessions once. Operators reconnect and sign in; pending documents remain intact. `PERMIT_SECRET` also derives the session lookup key. Rotate it after queues drain and permits expire, or through an explicitly reviewed reconciliation procedure. Previous signing-key overlap is not implemented.

Production requires an exact HTTPS origin, disabled demo mode, a sufficiently long signing secret and restricted `counter_pos_app`. Secret files are exclusive with direct values. Startup/readiness reject ownership, privileged roles/memberships, schema creation, historical DELETE access and migration drift. Logs expose request IDs/paths/status and generic error codes, without credentials or request bodies. Health and graceful shutdown support operator monitoring; no external monitor is configured.

## Stock and recovery

Migration 007 advances the inventory revision whenever balances change. Stock/product/sale/refund writers acquire the store lock before business locks. Writes are serialized for this one-terminal contract. Each catalogue page uses repeatable-read isolation; continuations bind catalogue and inventory revisions. A changed revision restarts the snapshot.

Local UUID/hash pairs receive explicit matching posted coverage or external-reconciliation dispositions. New stock, document dispositions and delta retirement are applied together under the IndexedDB writer lease. A lost response cannot silently deduct stock twice. Writer checks also cover cart, holds, administrative commands and synchronization. Authentication failure clears cached authorization and stale payment dialogs while preserving recoverable records. Offline expiry, revision coverage and clock rollback gate checkout. A disconnected terminal cannot receive immediate remote revocation; replay validation remains authoritative.

Rejected sales retain their UUID/hash/body for manager review. External reconciliation preserves financial history and records a reason/reference. The terminal retains `EXTERNALLY_RESOLVED` with its original body, stops retrying and excludes unposted resolved documents from pending close reconciliation. Canonical conflicts are linked explicitly to the existing canonical sale, without becoming another sale. The server blocks a resolved unposted UUID from later posting. Cash and physical stock must be corrected and documented before managers record this disposition.

Browser recovery V2 encrypts sales and saved stock/refund/cash commands with original operator/identities. V1 sale-only files remain importable. Imported dispositions require server confirmation and never authorize a new posting. Uncertain commands retain their UUID instead of creating another financial event.

## Migration and operations

The migrator commits normalized-SQL SHA-256 with each migration. Editing an applied file refuses deployment; append a forward migration. Legacy filename-only rows require reviewed, one-time `BASELINE_LEGACY_MIGRATIONS=1`. That baseline identifies current reviewed files and cannot prove historical SQL. Readiness/release checks compare deployed hashes against packaged files.

The package contains compiled Node 24 runtime/operations images, Caddy HTTPS, private PostgreSQL, separate administrator/migrator/runtime credentials, read-only serving storage and bounded resources. Initial setup creates the store, manager, General category and Main counter without demo sales.

Retained backups stream consistent PostgreSQL archives into authenticated RSA-OAEP/AES-GCM encryption with owner-only output. The private key belongs on a separate recovery host. Restore creates a guarded new database and checks table digests, migrations and financial/stock invariants before separately authorized promotion. See the production/backup runbooks.

`production:rehearse` exercises synthetic isolated containers, local-CA HTTPS, financial flows, retained encrypted restore, shutdown and verified cleanup. Public DNS/ACME/deployment, off-host retention/scheduling, achieved RPO/RTO, physical devices and business/legal approval remain explicit release gates.
