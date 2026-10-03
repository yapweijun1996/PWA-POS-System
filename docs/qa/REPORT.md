# Production hardening and local release evidence

Prepared 3 October 2026, Asia/Singapore. The single-store POS now includes production account controls, exact stock/recovery reconciliation and a deployable Docker/HTTPS package. This report supersedes the earlier local V1 QA handover; the original design kit remains preserved. Public deployment and physical acceptance are separate release gates.

## Delivered scope and source identity

The existing selling, catalogue, stock, returns, reporting and cash-close workflows remain. Added named operator management, asynchronous password hashing, versioned/keyed sessions and revocation, strict production configuration, restricted-role readiness, migration checksums, graceful shutdown, retained encrypted database backups and isolated restore. Browser recovery V2 also preserves uncertain stock/refund/cash commands and their original operators. Reconciled rejected sales retain their UUID/hash/body and any canonical receipt link.

The production API and compiled application remain unchanged by the isolated Pages demonstration. Its two additional browser scenarios pass (canonical checkout, real offline cache reload with preserved records, no API requests and mobile/reset coverage), recorded in [pages-results.json](pages-results.json). Publishing instructions are in [the Pages runbook](../runbooks/github-pages.md). GitHub Actions provides current remote verification/deployment status for the exact pushed commit.

Delivery branch: `codex/production-hardening`; baseline: `53ef64e039072c8802609a2350af9acd83de6969`. The enclosing commit identifies delivered source. [build-metadata.json](build-metadata.json) records exact source/built hashes and shell identity; [summary.json](summary.json) records final counts. Generated `dist/` and `build/`, local databases, backup files and secrets are ignored. `MANIFEST.sha256` covers the distributed source/design/QA package.

## Executed checks

Node 24.19.0; local PostgreSQL 16; macOS headless Playwright browsers. Database tests target only the guarded loopback synthetic `counter_pos_test` fixture and execute sequentially. Application transactions use the non-owner `counter_pos_app` role. Production operations use isolated Linux/arm64 Docker containers, PostgreSQL 16 and a certificate-verified local HTTPS endpoint.

| Check | Result | Evidence and scope |
| --- | --- | --- |
| Strict TypeScript, compiled server and Vite production build | PASS | `npm run build`, `npm run typecheck` |
| Formatting and diff whitespace | PASS | `npm run format:check`, `git diff --check` |
| Unit tests | 27 PASS | [unit-results.json](unit-results.json); money, configuration, offline gates, dispositions, commands and encrypted operations |
| PostgreSQL integration | 29 groups PASS | [integration-results.json](integration-results.json); actual transactions, concurrent requests and restricted roles |
| Chromium complete regression | 28 PASS | [browser-results.json](browser-results.json); zero skipped/unexpected/flaky |
| Firefox compatibility | 7 PASS | [browser-results-firefox.json](browser-results-firefox.json); selected critical scenarios |
| WebKit compatibility | 7 PASS | [browser-results-webkit.json](browser-results-webkit.json); selected critical scenarios and real origin outage |
| Final harness follow-ups | Chromium 2 / WebKit 2 PASS | Separate `browser-results-*-focused.json`; no production behavior or CSP relaxation |
| Production container drill | PASS | [production-operations-results.json](production-operations-results.json); exact runtime source hashes, HTTPS financial flow, retained backup/restore and shutdown |
| Compatibility backup rehearsal | PASS | [backup-results.json](backup-results.json); eight migrations, exact receipt identities/ledgers and a new restored-runtime sale/replay |
| Credential/public-bundle boundary scan | PASS | [security-results.json](security-results.json); bounded pattern scan, not a penetration test |
| Dependency audit | 0 vulnerabilities | [dependency-audit.json](dependency-audit.json); pinned installed dependency tree |
| API contract validation | 36 paths / 212 local references PASS | [contract-results.json](contract-results.json); YAML/reference/runtime schemas, not complete OpenAPI conformance certification |
| Retained local demo health | HTTP 200 live / ready | Loopback synthetic development data retained |
| Distributed package integrity | 250 file checksums PASS | `python3 validation/validate_bundle.py`; required files and canonical fixture arithmetic |

Integration covers concurrent/late/lost-response replay, exact payload hash coverage, inventory cursor invalidation, cost projection, CSRF/origin rejection, store scope, immutable receipts, stock retries, concurrent refunds and cumulative cent allocation. It also covers valid historical offline shortages, rejected/expired/revoked permits, cross-business-date reports, registered-document close races, negative-stock gates and the exact `32000 + 1400 + 2000 - 600 = 34800` cash count. External reconciliation and posting share the same UUID lock; resolved documents cannot create another sale. Runtime SQL cannot rewrite quarantined original payloads or identities. Migration drift fails readiness/deployment; a legacy checksum baseline requires explicit review.

Account checks include secure cookies, disabled production demo, cashier denial, password reset/change, session replacement/revocation, stale versions, last-manager protection and concurrent permission changes. Browser tests exercise operator Settings, manager-to-cashier cached-cost isolation, atomic quota abort, normal offline reload, multi-tab ownership, uncertain-command retries, lost-ACK stock projection, cash-count draft reload, depleted-stock payment review, canonical/external recovery, safe waiting-worker updates, 500-product administration and configured MYR labels/receipt snapshots. The MYR fixture restores only its isolated store configuration; historical financial currencies remain unchanged.

WebKit uses a stoppable loopback test proxy for the outage case because Playwright 1.63's offline flag rejects service-worker navigation, including local responses, as reported [upstream](https://github.com/microsoft/playwright/issues/42775). The test requires a failed uncached health request, a real reload returning HTTP 200 from the worker, a new document identity, unchanged original UUID/hash and successful ACK after recovery. This is server-unavailability coverage, distinct from Chromium/Firefox offline emulation. Physical Safari/iOS offline lifecycle remains NOT RUN. Safe-area simulation inserts CSSOM rules into the existing same-origin stylesheet; production CSP remains enabled.

## Screens and performance

No root horizontal overflow was observed at 390×844, 430×932, 768×1024, 1024×768 and 1440×900. Product image decoding, keyboard/Escape focus return, long text, simulated safe-area padding and 720×450 equivalent reflow are exercised. These checks do not certify an actual phone keyboard, OS zoom, screen reader or installed-PWA lifecycle.

[Desktop](screenshots/sell-1440.png), [phone](screenshots/sell-390.png), [receipt](screenshots/receipt.png), [MYR receipt](screenshots/receipt-myr.png), [desktop update](screenshots/update-desktop.png), [mobile update](screenshots/update-mobile.png). The update and MYR screenshots were visually inspected. [performance-results.json](performance-results.json) contains 30 warm DOM-update samples on 500 synthetic products; its measured p95 values are desktop observations, not low-end handset claims.

## Deployment, migration and recovery

The final production drill builds runtime and operations images from a source fingerprint that must remain unchanged during the run. It verifies non-root/read-only serving, separate owner/migrator/runtime credentials, unexposed PostgreSQL, certificate-verified local HTTPS, HSTS/CSP, secure login, stock receipt, cash sale/identical retry, refund and reconciled shift close. A retained RSA-OAEP/AES-GCM backup is restored into a fresh database; every table digest/count matches, including eight migrations, one sale/payment/refund and three stock movements. SIGTERM exits cleanly; its unique containers, networks, volumes, credentials, private key and fixture archives are removed and cleanup is verified. Image IDs and limits are recorded in the report; no registry promotion is implied.

Migrations 001–005 remain unchanged; forward migrations 006–008 add security, inventory revision and quarantine privileges. SQL and normalized SHA-256 metadata commit together under the migration lock. Existing filename-only records require a reviewed explicit baseline; it identifies current files and cannot prove historical SQL. Migration 006 invalidates old sessions once, so existing operators sign in again without deleting pending documents. Planned signing-key rotation must first drain/reconcile queues and replace permits. No overlapping old-key grace period is implemented.

The local synthetic development database and demo are retained. Browser recovery never replaces a live database or clears pending records. V2 retains sale documents and saved administrative commands; imported dispositions need server proof. See [ADR 002](../adr/002-production-hardening.md), [production](../runbooks/production.md), [retained backup/restore](../runbooks/production-backup.md) and [terminal recovery](../runbooks/recovery.md).

The separate compatibility rehearsal restored 500 products, 11 sales/payments, one refund and 523 stock movements with matching migration identities, receipts, balances and financial reconciliation. A new sale and identical replay then succeeded as the non-owner runtime role. Its temporary encrypted archive and recovery database were removed. This does not replace the retained operational backup workflow or establish an RTO.

## Resolved failures and remaining release gates

This work fixed unversioned inventory pagination and lost-ACK double deduction, stale authorization/cost caches, writer checks outside checkout, uncertain command identity loss, reconciliation/posting races, close checks after late registration, and incomplete migration/role readiness. It also fixed the update banner blocking checkout, forced synchronization joining an obsolete snapshot, hardcoded SGD labels in MYR, Docker bootstrap execution permissions, encrypted-stream finalization and an explicit restore database argument. Final executed checks retain their original assertions; no failure is hidden by skipped tests or weaker acceptance criteria.

[The 32-case matrix](../../specs/test-cases.csv) distinguishes automated passes from partial/manual/physical coverage. Client clock rollback has unit coverage; actual browser clock injection is NOT RUN. Physical iPhone/Android installation, suspension/resume, printer/scanner, actual keyboard/zoom, independent screen-reader/WCAG review and penetration testing are NOT RUN. Public production DNS/ACME/backend deployment, off-host transfer/retention scheduling, a separate-host restore and achieved RPO/RTO are NOT RUN. Container local-CA HTTPS is verified and does not establish public certificate issuance.

Card/PayNow remain manual external records; real payment-provider/ERP integration, fiscal/tax policy, retention and shop-specific approval are outside this single-store implementation contract. All tests use synthetic data. Live promotion requires the chosen server/domain, approved private secrets and backup destination, exact-commit CI and physical shop-terminal acceptance.

The first GitHub branch run exposed a timing-dependent T26 failure after fault injection. The fixture now waits for the complete manual drain and refresh before removing the network fault; eight consecutive local repetitions passed. CI retains Playwright failure traces with QA evidence. The final Actions run is authoritative for remote validation.

The subsequent GitHub Linux run passed browser, backup and dependency checks, then exposed a host/operator UID mismatch while reading the private restore report. The production drill now reads that report through the same operator container and asserts mode 0600; the local production drill passed after this change.
