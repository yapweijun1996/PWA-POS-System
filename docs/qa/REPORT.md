# Local V1 implementation and QA evidence

Prepared 2 October 2026, Asia/Singapore. The requested repository now contains a working single-store POS, durable inventory ledger and bounded offline cash workflow. This report supersedes the historical design-kit application status in `validation/REPORT.md`. It is a local implementation handover, not approval for a pilot, production deployment or full acceptance certification.

## Delivered scope and source identity

Implemented React/TypeScript/Dexie client, Fastify/PostgreSQL API, shared bounded integer-money/return rules, validated contracts, migrations, synthetic setup/demo, tests, CI configuration and operating/recovery runbooks. Products/categories/pricing/archive, stock receipts/counts, search/cart/holds, cash and online manual external records, immutable receipts, manager refunds, daily reporting/CSV/audit, cash in/out/count/close, local outbox/replay, writer lease, permits, explicit PWA updates and encrypted recovery are present. Original illustrations, prototype, PDFs and reference schema remain preserved.

- Branch: `codex/counter-pos-v1`. Baseline commit: `3009f51bd236137c3ee848774b52d0173661be1b`. Verification was recorded before commit. The enclosing Git commit identifies the delivered source; no push, merge or deployment is claimed.
- Built shell: `counter-shell-a0127c71bd071edc`. Application-source fingerprint: `a5e74f4d94d10cbdf05fbb3186cb87d78dfebf9c9bc4e927df450a7f3a0a76b5`.
- Exact per-file source and built-asset SHA-256 values: [build-metadata.json](build-metadata.json). Generated `dist/` is ignored and reproducible with `npm ci` / `npm run build`; source package integrity is checked separately by `MANIFEST.sha256`.
- Changed implementation is in `apps/`, `packages/`, `infra/`, `scripts/`, `tests/` and `.github/`; README, ADR, API contract, acceptance matrix, package index and integrity manifest reflect this handover.

## Executed checks

Node 24.19.0; PostgreSQL 16.10 (Homebrew); Darwin 25.6.0. Browser: Playwright Chromium 153.0.8010.12, desktop headless, no CPU/network throttling. Trusted localhost; no physical handset. Database launchers target only the loopback synthetic `counter_pos_test` database and refuse other names/hosts. The API tests run as `counter_pos_app`, a non-owner role.

| Command / check | Actual result | Evidence and limit |
| --- | --- | --- |
| `npm run build` / `npm run typecheck` | PASS, strict TypeScript and Vite assets | No unused locals/parameters; exact build hashes above |
| `npm run format:check` | PASS | Prettier checks application, shared rules, scripts, tests and configs |
| `npm test` | 8 PASS | 6 money/refund/contract tests plus 2 production-config tests; `tests/unit/` |
| `npm run test:integration` | 15 groups PASS | [integration-results.json](integration-results.json), actual PostgreSQL transactions and roles |
| `npm run test:e2e` | 18 PASS, 0 skipped/unexpected/flaky | [browser-results.json](browser-results.json); final full run 87.2 seconds |
| `npm run backup:rehearse` | PASS | [backup-results.json](backup-results.json); restore and new sale verified |
| `npm run security:check` | PASS | [security-results.json](security-results.json); pattern/public-bundle boundary scan |
| `npm audit --audit-level=moderate` | 0 vulnerabilities | Current pinned dependency tree; not a penetration test |
| `npm run contracts` | PASS, 30 paths / 198 local references | [contract-results.json](contract-results.json); YAML/reference/runtime-fixture checks, not full OpenAPI conformance certification |
| Local demo `/health/ready` and `/health/live` | HTTP 200, ready/live | Running at `http://localhost:3000`, synthetic mode |
| `git diff --check` | PASS | Intended source changes; no staging/push implied |
| `python3 validation/validate_bundle.py` | PASS | All distributed source/design/QA file checksums and canonical fixture arithmetic; application tests are separate |

The unit money fixture is exactly 1400 due, 2000 tender and 600 change. Six domain tests also reject floating values/overflow, exercise artificial half-up tax and allocate every refund net/tax cent over quantities 1–99. Tax remains disabled in the application.

The integration suite proves concurrent replay creates one sale/payment and one stock movement per line; an actual HTTP response dropped **after COMMIT** retries to the original receipt; altered content returns 409. It checks role/cost projection, CSRF/origin refusal, a genuine foreign-store category and composite FK refusal, historical write rejection, stock-command replay, secure password cookies/production demo refusal, concurrent final-unit refunds, partial rounding/damaged returns, price/version snapshots, valid historical offline negative-stock posting, invalid permits/quarantine, daily totals, cash movement identity, reconciliation/variance and schema readiness.

The browser suite proves local atomic quota abort with no partial rows and a preserved cart, offline receipt persistence through normal reload, foreground ACK and stock-delta removal, lease takeover, a real waiting worker N→N+1 upgrade, honest fresh-offline failure, expired-session recovery with the same sale identity, actual product/stock/refund flows, encrypted export/import without duplicated sales, uncertain cash request persistence/retry, price-review gating and unchanged archived receipt snapshots. The final price/archive test runs after the 500-product fixture, covering administration beyond its first page.

## Screens and performance

Observed no root horizontal overflow at 390×844, 430×932, 768×1024, 1024×768 and 1440×900. Product-image decoding is asserted. Keyboard/Escape focus return, injected long text, simulated safe-area padding and a 720×450 equivalent reflow are exercised. This is not actual OS keyboard, browser zoom or iPhone safe-area certification. Desktop and phone screenshots were visually inspected after fixing SVG namespace loading.

[390 phone](screenshots/sell-390.png), [430 phone](screenshots/sell-430.png), [768 tablet](screenshots/sell-768.png), [1024 tablet](screenshots/sell-1024.png), [1440 desktop](screenshots/sell-1440.png), [receipt](screenshots/receipt.png).

The cached-catalogue benchmark uses 500 synthetic products and 30 observed DOM-update samples per operation. Nearest-rank p95 is **27.0 ms add** (target <100 ms) and **2.0 ms search** (target <150 ms). [performance-results.json](performance-results.json) records the exact user agent and measurement method. These warm desktop measurements are not low-end mobile performance claims.

## Acceptance coverage and remaining gaps

[specs/test-cases.csv](../../specs/test-cases.csv) now records evidence and coverage notes for all 32 planned cases. `PASS_AUTOMATED` means the specified automated result was exercised. `PARTIAL_*` preserves the passing subset and explicitly names unexecuted facets. Passing 18 browser tests does not mean all 32 mixed browser/manual/hardware acceptance scenarios are complete.

Physical iPhone/iOS standalone lifecycle (T31), Android handset, hardware scanner and thermal printer are **NOT RUN**. Firefox/Safari, independent screen-reader/WCAG review, actual keyboard/zoom/suspension, production HTTPS, remote GitHub CI, deployment, operational backup schedule/off-host retention/key custody, achieved RPO/RTO and penetration testing are **NOT RUN**. No real provider, ERP data or customer/business data is used. Additional automated facets not separately injected include rapid UI double-click, rendered identity-conflict review, cash-count draft reload, payment-only worker update, multi-pending watermark, client clock-rollback expiry, cross-business-date report fixture and the literal 34800 canonical cash-out/count fixture; their covered counterparts are stated in the CSV.

## Failures found and resolved

- Missing independent SVG namespaces caused broken product illustrations; fixed and added image-loaded assertions.
- Stored repeat requests could be silently replaced by a new form or cash in/out could duplicate after a lost response; stable IDs/frozen operator-owned commands, explicit retry and a close gate now prevent this. A browser fault after the actual cash response confirms the retry leaves one row.
- Product administration loaded only the first 100 products; it now follows all bounded continuations. The 500-product price/archive scenario and final full regression pass.
- Early dependency audit flagged YAML 2.8.2; pinned 2.9.1 and re-audited with zero findings.
- PostgreSQL historical row locks require identity-column UPDATE grants; an explicit migration grants those locks while immutable triggers reject all actual mutations. Runtime-role refunds and restored-runtime sales now pass.

No unresolved failure remains in the executed automated suite. Unexecuted acceptance facets and pilot boundaries above remain explicit release gates.

## Migration and recovery handover

Five ordered migrations (001–005) commit SQL and version records together under a migration lock. Server startup does not migrate production. The local demo migrates only its synthetic development database. Keep the non-owner runtime role separate from the owner migration/setup role. CI explicitly prepares its synthetic runtime password; demo/dev can use a separately injected `RUNTIME_DATABASE_URL`. Client database V1 and pending-document identities are retained.

The backup rehearsal restored 4 sales, 4 refunds and 22 stock movements from an encrypted 0600 custom archive into a new disposable database. Counts, UUIDs/hashes/receipt numbers, migration versions and financial/stock invariants matched. A new restored cash sale and identical retry succeeded as the non-owner role. Observed rehearsal duration 4.65 seconds is not an operational RTO. Rehearsal databases/archives were removed; the development database is retained for the demo.

Browser recovery exports only sale outbox documents, validates encryption/checksums/UUIDs and imports atomically without deleting existing data. Saved online stock/refund/cash requests remain on the original terminal and are excluded from this sale-only package. Never clear browser data or replace a live database to recover. See [local-development.md](../runbooks/local-development.md), [recovery.md](../runbooks/recovery.md) and [ADR 001](../adr/001-v1-implementation.md).

Recommended next milestone: execute the documented physical device/scanner/printer and remaining acceptance matrix on the selected shop terminal, then review production hosting, retained backups, license/brand and tax/retention decisions before a controlled pilot.
