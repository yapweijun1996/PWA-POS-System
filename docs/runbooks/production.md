# Production delivery and operator controls

This is the deployment contract for the single-store V1. An implementation or local container drill does not authorize a public deployment, establish a tax policy, certify a payment integration, or replace physical printer/scanner/browser acceptance. Release evidence belongs to the exact reviewed Git commit and image digests.

## Images and services

`infra/Dockerfile` produces two images. The `runtime` image contains compiled server JavaScript, the built PWA and production dependencies; it runs as UID 1000. The `operations` image contains the same reviewed migrations and PostgreSQL 16 command-line tools; it runs as UID 999 and is invoked only for operator jobs. It has no HTTP listener. Source TS is compiled using `tsconfig.server.json`; Node does not interpret unsupported TypeScript syntax at runtime.

`infra/compose.production.yaml` keeps PostgreSQL on an internal network with no host port. Caddy is the only published service and terminates HTTPS on the same origin as the API/PWA. The app has a read-only root filesystem, drops Linux capabilities, waits for database health, has bounded memory/process counts and receives a forty-second shutdown grace period. Database and certificate state use named persistent volumes. Container logs rotate; Caddy access logs are disabled to avoid retaining customer URLs or authentication material.

The stack is a single-host deployment. A failed host interrupts serving and consumes the outage budget. PostgreSQL durability, host disk capacity, Docker restart behavior, certificate renewal, monitoring and off-host copies remain operator responsibilities. Do not run multiple writable terminals or add replicated app/database instances without reviewing the one-terminal/one-shift consistency contract.

`npm run production:rehearse` is a local release rehearsal requiring Node 24, Docker/Compose and curl. It builds the reviewed runtime/operator images, initializes a unique synthetic stack, validates local HTTPS with Caddy's local CA, exercises secure login and a complete financial flow, restores a retained encrypted backup and checks graceful shutdown. It removes and verifies removal of only its unique containers/networks/volumes and temporary private-key/credential files. Runtime source hashes are captured before the image build and must remain identical when the run completes; concurrent runtime edits refuse a PASS. The sanitized evidence is `docs/qa/production-operations-results.json`. This command does not publish ports beyond a loopback test endpoint, request public certificates or touch an existing database.

## Private configuration and initial setup

Set non-secret deployment values in an operator-owned environment file outside Git:

```dotenv
APP_HOST=pos.example.com
ACME_EMAIL=operator@example.com
APP_IMAGE=counter-pos:<reviewed-commit>
OPS_IMAGE=counter-pos-operations:<reviewed-commit>
RELEASE_REVISION=<full-reviewed-git-commit>
SECRETS_DIRECTORY=/srv/counter-pos/secrets
BACKUP_DIRECTORY=/srv/counter-pos/backups
```

Replace the example hostname/contact before deployment. For promotion, pin `APP_IMAGE`, `OPS_IMAGE`, PostgreSQL and Caddy to recorded registry digests; exact tags in the checked-in files are build inputs, not a promise that registry tags never change. Build once, test those artifacts, record `docker image inspect` digests and promote those artifacts rather than rebuilding after approval.

Provide each credential through a private secret file. Compose mounts only the files that each service needs; it does not encrypt their host storage. Restrict the parent secrets directory to operator/root access. Linux bind-file ownership is significant: the serving process is UID 1000 and the operator process is UID 999. Compose file-backed secrets do not reliably remap file ownership. The `runtime-database-url` and `permit-secret` files must be readable by UID 1000; `migrator-database-url` and `backup-recipient.pem` by UID 999. Use mode 0400 with the appropriate owner or an explicitly restricted group. The owner/migrator/runtime password files are needed only by PostgreSQL's initial bootstrap and must be readable by its UID 999 after the official image drops privileges. Test these permissions using the final images. Never make a private production credential world-readable to work around a permission error.

Required files:

| File                    | Consumer                        | Meaning                                                                                                                        |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `owner-password`        | PostgreSQL first initialization | Random database administrator password; never mounted into the app                                                             |
| `migrator-password`     | PostgreSQL first initialization | Separate random migration login password                                                                                       |
| `runtime-password`      | PostgreSQL first initialization | Separate random restricted runtime password                                                                                    |
| `migrator-database-url` | Operator jobs                   | `postgresql://counter_pos_migrator:<encoded-password>@postgres:5432/counter_pos?sslmode=disable` on the private Docker network |
| `runtime-database-url`  | App/release checks              | Same private target with `counter_pos_app` and its own encoded password                                                        |
| `permit-secret`         | App/release checks              | At least 32 random characters; use a cryptographic random generator                                                            |
| `backup-recipient.pem`  | Backup creation                 | Approved RSA public key, at least 3072 bits                                                                                    |

The database init script creates the migration and runtime roles on an empty PostgreSQL volume. The migration role owns application tables and can create objects in the app schema, but has no superuser, role-administration or database-creation rights. The runtime role is never an owner. Existing volumes are not reinitialized when files change. Rotate PostgreSQL passwords through an authenticated administrator session and change matching secret files together; editing a file alone does not rotate a database credential.

`sslmode=disable` above is confined to the unexposed internal Docker network. When using an external database, configure certificate-verified TLS and a private route. Do not publish PostgreSQL's port or relax production role checks.

From the repository root, after operator authorization to initialize the chosen empty deployment:

```sh
docker compose --env-file /private/deployment.env -f infra/compose.production.yaml config --quiet
docker compose --env-file /private/deployment.env -f infra/compose.production.yaml build app operations
docker compose --env-file /private/deployment.env -f infra/compose.production.yaml up -d postgres
docker compose --env-file /private/deployment.env -f infra/compose.production.yaml run --rm operations migrate
```

Initial manager setup uses `operations setup`. Mount a one-time private password file into that operator job at `/run/secrets/setup_password`, set `SETUP_PASSWORD_FILE` to that path and provide `SETUP_EMAIL` plus the reviewed `SETUP_STORE_NAME`, `SETUP_CURRENCY`, `SETUP_TIMEZONE` and `SETUP_DISPLAY_NAME` through a private operator environment file. `docker compose run --env-file <file> -v <password-file>:/run/secrets/setup_password:ro operations setup` supplies these without embedding a password in shell arguments. The setup command refuses an existing store. Remove the one-time password file after successful bootstrap and retain the credential in the approved password manager. Do not seed demo data into this deployment.

```sh
docker compose --env-file /private/deployment.env -f infra/compose.production.yaml run --rm release-check
docker compose --env-file /private/deployment.env -f infra/compose.production.yaml up -d app proxy
```

The first release check verifies restricted runtime privileges, the exact migration set and database financial/stock invariants. It reports the HTTPS probe as NOT RUN before serving. After DNS/certificate/HTTPS are available, run the same job with `RELEASE_PROBE_URL=https://<configured-host>`. The probe validates certificates, demo-disabled liveness, readiness, HSTS, CSP and the app shell. Use normal browser validation too. An HTTP 200 alone does not prove all POS flows or physical hardware work.

Applied migrations record SHA-256 hashes of reviewed SQL normalized to LF. Startup/readiness and release checks compare those hashes with the image's migration files; an edited historical migration or an unknown/missing migration fails. Append a new forward migration rather than rewriting applied history. Older V1 databases recorded filenames only. Before upgrading one, take a retained backup, review its existing schema and original migration evidence, and test the upgrade/restore in isolation. Only then may an operator run `operations migrate` with `BASELINE_LEGACY_MIGRATIONS=1`. That explicit flag records current reviewed hashes and a baseline timestamp; it cannot prove which historical SQL originally ran. Never use the flag to accept a known mismatch or automate away failed verification.

`PERMIT_SECRET` also derives session lookup keys. Planned rotation therefore requires the terminal online, every pending sale/administrative command confirmed, active shifts reconciled/closed and an encrypted recovery export retained before replacing the secret and restarting the app. All existing cookies will require sign-in, and old offline permits will no longer validate; obtain new permits after reconnecting. There is no dual-key grace period. During an emergency credential incident, revoke/rotate under the approved incident procedure, preserve original pending UUIDs/receipts and investigate affected offline records through manager reconciliation. Never erase the queue or re-enter the sale with a new UUID to bypass the rejected permit.

## Backup, monitoring and release gates

Use [retained encrypted backup and isolated restore](production-backup.md). The backup command returns success only after the encrypted archive and checksum metadata are flushed. Configure an operator-owned scheduler and an approved off-host transfer with least-privilege credentials. Do not call local retained files “off-site backups.” No destination, recurring job, achieved RPO or achieved RTO is invented by this repository.

Monitor readiness failures, process restarts, failed login/rate-limit events, database disk/WAL capacity, oldest unsynchronized terminal document, quarantines, backup last-success time, verified off-host transfer and periodic restore drills. `/health/live` measures process liveness and `/health/ready` additionally verifies database availability/schema/role restrictions. Docker health status alone does not restart an unhealthy process; an external monitor must alert or an operator must investigate.

Before a live pilot, require exact-commit CI, a restore drill on a separate recovery host, approved retention/access/brand/tax decisions, manager and cashier account enrollment, physical terminal install/offline/reconnect/update/reprint tests, printer/scanner acceptance and an outage procedure. Record each unperformed item as NOT RUN rather than changing the gate to PASS.

For an upgrade, take and verify a fresh backup, inspect forward migrations, apply them as a separate reviewed operator action, then replace the app image. Active browser clients must synchronize, empty their draft/outbox and explicitly approve the waiting service-worker update. A pending database/browser document is never deleted to make an upgrade pass.

For rollback, prefer a compatible prior app image against the current additive schema. Verify its readiness/contract first; the exact migration-set release gate deliberately requires review when the app's schema contract differs. If data restoration is required, restore into a newly named isolated database, verify all evidence, enroll the correct runtime account and execute a separately authorized cutover. Never downgrade or overwrite the live database as a routine rollback shortcut.

## Primary references

The service/secret/health contract follows [Docker Compose service definitions](https://docs.docker.com/reference/compose-file/services/), [startup dependency behavior](https://docs.docker.com/compose/how-tos/startup-order/) and [file-backed secrets](https://docs.docker.com/reference/compose-file/secrets/). Certificate and proxy behavior follows [Caddy automatic HTTPS options](https://caddyserver.com/docs/caddyfile/options) and [security header configuration](https://caddyserver.com/docs/caddyfile/directives/header).
