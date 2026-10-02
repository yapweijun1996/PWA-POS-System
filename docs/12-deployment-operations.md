# 12 · Deployment, environments and operating runbook

> 中文重点：GitHub 放源码和展示；真正 POS 的 API 和数据库另外部署。

## Environment separation

Local development uses disposable data. CI uses ephemeral databases. Public demo has synthetic data and limited privileges. Pilot/production has separate database, credentials, storage and backup policy. Never point a demo build at an ERP or real shop database.

Recommended eventual topology: HTTPS reverse proxy → static client + API container → private PostgreSQL; optional object storage for product images/backups. Start with a single host or managed service suitable for the workload, not a price estimate. Hosting selection and costs need current provider-specific research when requested.

GitHub Pages is a static hosting service: suitable for this documentation or a clearly browser-only portfolio demonstration, not for running the Node API or PostgreSQL. [S08] A real PWA has HTTPS/secure-origin and update considerations beyond uploading HTML. [S02]

## Build and configuration

Pin runtime and package versions, commit lockfiles, build immutable frontend assets and label API/client/database migration versions. Use server-only secrets via a secret manager or environment injection. Public client configuration contains only API base and non-sensitive display values. No database passwords, manager secrets or private signing keys in frontend `VITE_*` variables.

Set HTML/service-worker caching to permit update checks; hashed immutable assets may be long-lived. Use a restrictive CSP and appropriate MIME/cache headers. `/health/live` checks process liveness without secrets; readiness verifies required dependencies without leaking internal connection details.

## Release procedure

Review diff and migrations → build/test exact commit → back up and verify restore availability → deploy to staging → run sale/refund/offline-upgrade smoke suite → confirm no incompatible pending-client schemas → controlled release → observe logs/queue/negative-stock exceptions → document rollback build and migration compatibility.

A client update must wait for safe activation. Do not delete old caches or IndexedDB stores just to force users onto a new version. Database migrations use a separately authorized role; the runtime role should not own all schema objects.

## Operational checks

Before opening: server reachable, terminal identified, catalogue current, local persistence self-test passed, clock/permit valid, opening float recorded. During the day: inspect pending count and last successful sync. At closing: drain queue, resolve reviews, count cash, record variance and close shift online.

If API is down, authorized cached cash selling can continue inside the permit boundary. If IndexedDB fails, stop checkout and use the owner's separate contingency procedure; do not promise that refreshing will recover unsaved sales. If the terminal is lost, restore only server-confirmed data plus any previously exported recovery package; disclose unsynced-data exposure.

## Backup / restore rehearsal

Create an encrypted backup, checksum and build/migration manifest. Restore to an isolated target; verify rows, stock sums, sale/payment sums, refunds and receipt uniqueness. Exercise one post-restore sale in the isolated environment, then discard test changes. Measure duration and recoverable timestamp. Store evidence with the release.

## Incident recovery

For duplicate suspicion, search by original UUID and request ID before retrying. For a sync conflict, preserve payload, receipt and local state; do not clear browser storage. For negative stock, inspect all referenced movements and physical count. For failed update, retain queued data and roll back to a compatible build. Every manual correction needs actor/reason/audit trail.

## Scope of this delivery

No service, container, cloud bill, GitHub repository, domain, backup automation or scheduled monitoring has been created by generating this kit. The deployment model and commands to be implemented remain future work.


## Local implementation follow-up

The local V1 now has pinned builds, five migrations, a non-owner API role, a synthetic demonstration and CI configuration. See [the implementation ADR](adr/001-v1-implementation.md), [local runbook](runbooks/local-development.md), [recovery runbook](runbooks/recovery.md) and [executed QA](qa/REPORT.md). Hosting, HTTPS production, retained/off-host backups, RPO/RTO, public release and physical pilot checks remain unexecuted. The original kit-scope description above is historical.

## Production hardening follow-up

[ADR 002](adr/002-production-hardening.md), [production deployment](runbooks/production.md) and [retained encrypted backup](runbooks/production-backup.md) supersede affected local-only statements above. The package now includes non-root containers, same-origin HTTPS, separate owner/migrator/runtime credentials, checksum-enforced migrations and isolated production-stack/restore verification. The exact performed checks are in [QA evidence](qa/REPORT.md). Public hosting, off-host retention/scheduling and achieved RPO/RTO still require the chosen operating environment.
