# Recovery and release operations

## Pending browser records

Keep the app open to synchronize. PENDING/RETRY retains the exact UUID/body. AUTH_REQUIRED needs the original operator to sign in again. NEEDS_REVIEW preserves the receipt and payload; blind retries and new IDs are inappropriate. A print error does not undo a sale.

Unconfirmed online stock, refund and cash requests are listed separately in Sync center. Retry the saved request as its original operator; do not re-enter it with a new UUID. New administrative changes and shift close wait for this confirmation. Authentication failures preserve the request. A definite validation/version rejection allows a refreshed draft; identity conflicts remain for investigation. These saved administrative commands are local retry records and are not included in the sale-only encrypted recovery package.

Managers can export an encrypted recovery package from Sync center. Use a unique private passphrase of at least twelve characters; keep it separately from the file. Restore imports the same identities and ignores matching local duplicates. Wrong passphrase, invalid schema, altered checksums and conflicting identities abort the import. Existing documents are not deleted. Recover from a package only on the enrolled terminal or an explicitly reviewed replacement environment; a restored document still needs normal authentication and server validation.

For rejected server documents, Sync center exposes manager-only review cases. Investigate physical cash/stock and original receipt. Resolve only after recording an external reconciliation reference and reason. The original quarantined payload remains stored. This control does not convert unauthorized documents into sales or automatically adjust cash; final variance and stock corrections are separate auditable operations.

## Database backup

`npm run backup:rehearse` reads only the synthetic test database. It creates a 0600 custom-format archive, validates its catalogue, encrypts with AES-256-GCM and an ephemeral RSA-OAEP public key, decrypts and restores into a newly named isolated database. It compares critical row counts, original UUIDs/hashes/receipt numbers, schema versions, ledger balances, line/payment totals and refund limits. It also posts a new cash sale and verifies its identical replay using the restored non-owner runtime role. It removes its own temporary databases and archives. Read `docs/qa/backup-results.json` for the observed result.

For operational backups, inject a reviewed recipient public key and retain its private key outside the application/database host. Use restrictive modes, encrypt before off-host transfer, include media and build/migration metadata, and rehearse restore before a pilot. No backup scheduler, off-host destination, key escrow, achieved RPO or achieved RTO is configured by this implementation. Browser-only pending records are absent from PostgreSQL backups.

## Production boundary

Use a same-origin HTTPS reverse proxy, private database, random environment-managed permit secret and a non-owner runtime role. Production configuration rejects demo mode, HTTP origin and missing/short signing secret. Do not put server values in VITE_* variables. Runtime migrations are separate from serving. Review all grants and ensure the runtime is neither database/table owner nor superuser.

Before a pilot: review brand/license/tax/retention decisions, run CI on the exact commit, execute physical browser/install/printer/scanner checks, configure operational backups and demonstrate a compatible rollback with pending data. A new client waits for a safe user-approved service-worker activation. Never wipe IndexedDB or overwrite a live database to resolve an incident.
