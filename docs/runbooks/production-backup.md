# Retained encrypted backup and isolated restore

The operational workflow is separate from `backup:rehearse`, which destroys its synthetic rehearsal artifacts. `backup:create` retains a UUID-named `.posbackup` archive and `.json` metadata, both mode 0600. No private decryption key is required or accepted by backup creation.

## Key custody and creation

Generate a 3072-bit or stronger RSA recipient key on an approved recovery workstation/vault. For an encrypted PEM private key, an example command is `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -aes-256-cbc -out recovery-private.pem`; then export its public half with `openssl pkey -in recovery-private.pem -pubout -out backup-recipient.pem`. Keep the private half and its passphrase outside the application/database host. Mount only the public file for backup creation. Record/review its SHA-256 SPKI fingerprint through a trusted channel before activation and before rotation.

The app host connects to PostgreSQL with the private migration credential only inside the operator job. `pg_dump` reads a repeatable-read exported snapshot. The same snapshot supplies every public table's row count and SHA-256 digest, migration identities and sale/refund/payment/stock reconciliation. Row digests are streamed in batches; plaintext database content is not logged or stored in metadata. Snapshot/table scans can consume I/O and sort space, so schedule away from peak selling, monitor duration and rehearse against realistic retained volume. An unsuccessful dump removes its incomplete output and reports failure.

The dump's stdout streams directly into AES-256-GCM. A fresh random data key is wrapped with the recipient public key using RSA-OAEP/SHA-256. The header, including the integrity manifest, is authenticated as additional data. Only encrypted archive bytes are retained on the backup host. The sidecar records encrypted SHA-256, backup UUID/time, release revision, recipient fingerprint and migration list; it contains no database password or private key.

```sh
docker compose --env-file /private/deployment.env -f infra/compose.production.yaml run --rm operations backup
```

On a host with Node 24, dependencies and PostgreSQL 16 tools, `npm run backup:create` uses `DATABASE_URL_FILE`, `BACKUP_RECIPIENT_FILE`, `BACKUP_DIRECTORY`, optional `PG_BIN`, and the reviewed `RELEASE_REVISION`. Inject secrets privately. The retained output directory must be writable by the operator UID and restricted from other host users. A private mounted backup disk is preferable to the app image filesystem. Files are retained until the approved retention policy removes them; the command never prunes old backups.

Transfer both archive and metadata to an explicitly approved independent storage destination only after encryption succeeds. Verify the destination checksum and transfer status, alert on failure and record last verified successful transfer. Set RPO from the scheduled interval plus tolerated failures, and establish RTO by timed recovery drills. These quantities are operational targets until measured. PostgreSQL backups omit browser-only pending records, so retain the enrolled terminal's encrypted recovery export/outage procedure separately.

An encrypted checksum is an integrity check, not proof of the publisher's identity. Trust the approved backup storage/access controls and fingerprint distribution. Do not restore an archive from an untrusted sender; PostgreSQL restore archives can contain executable database definitions.

## Restore on a separate recovery host

Provision an isolated PostgreSQL 16 destination with the reviewed `counter_pos_app` role already present; the production bootstrap role SQL can be used on its empty cluster. Choose a maintenance credential with CREATE DATABASE rights on that recovery server. It must connect to `/postgres`. The destination is always a new `counter_pos_restore_*` database; existing targets are refused and never overwritten. A failed restore may leave an empty isolated database for inspection; cleanup of that explicitly identified target is an operator decision.

Copy the retained archive/sidecar to the recovery workstation. Supply:

- `BACKUP_FILE`: path to the retained `.posbackup` file.
- `RESTORE_PRIVATE_KEY_FILE`: private PEM on the recovery workstation, never the app host.
- `RESTORE_PRIVATE_KEY_PASSPHRASE_FILE`: optional private passphrase file for an encrypted PEM.
- `RESTORE_ADMIN_DATABASE_URL_FILE`: recovery server maintenance URL with its own credential.
- `RESTORE_DATABASE_NAME`: a fresh name such as `counter_pos_restore_drill_20261003`.
- `PG_BIN`: PostgreSQL 16 CLI directory when not on PATH.

```sh
npm run backup:restore
```

Restore first checks the encrypted checksum and authenticates the complete envelope. It decrypts into a private mode-0600 temporary archive only on the recovery host, validates the PostgreSQL archive catalogue, creates the fresh destination, then uses a single transaction and fail-on-error restore. It compares every table count/digest and migration identity against the authenticated snapshot manifest and recomputes financial/stock invariants. The temporary plaintext is removed on success or failure. An existing result sidecar is also never overwritten; archive the previous drill result deliberately before another drill of the same backup.

On success, `<backup>.restore-result.json` records `ISOLATED_RESTORE_VERIFIED`. It does not cut over traffic. Configure/enroll a non-owner runtime credential on that isolated database, run release checks, then run a new cash sale and identical UUID replay, receipt reprint, manager refund and count/close verification against synthetic drill data or an explicitly approved private recovery environment. Check media/client compatibility and reconcile any newer browser pending UUIDs. Record elapsed restore/application-validation time before claiming an RTO. Only an authorized cutover may change the live connection.

`pg_dump` does not export global PostgreSQL roles/passwords or the deployment secret store. The destination administrator establishes those independently; the archive preserves table grants to the named runtime role. Certificate/media/build artifacts and off-host copies need their own approved protection and recovery inventory.

The snapshot and custom archive behavior follows the official [PostgreSQL 16 pg_dump contract](https://www.postgresql.org/docs/16/app-pgdump.html) and [pg_restore contract](https://www.postgresql.org/docs/16/app-pgrestore.html). Run the isolated restore against the exact retained artifact, not a newly created substitute.
