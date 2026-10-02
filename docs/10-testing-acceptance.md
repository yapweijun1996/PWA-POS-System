# 10 · Test strategy and acceptance gates

> 中文重点：测试计划不是测试结果。当前应用的执行证据见 [docs/qa/REPORT.md](qa/REPORT.md)；validation/REPORT.md 保留原设计包的历史检查。

## Layers

Unit tests cover integer money, discount bounds, exclusive tax rounding, return allocation and status transitions. Integration tests run against disposable PostgreSQL and verify transactional invariants, store scoping, idempotency, locks and migration behavior. Browser E2E tests cover complete user journeys, IndexedDB transactions, offline/reconnect and responsive behavior. Physical devices/printers get a separate manual matrix.

Use deterministic fixtures and explicit fault injection; do not rely only on randomly toggling Wi-Fi. Add a test endpoint/proxy in test environments to drop the response after database commit, abort local writes, return 401/409/429/5xx and interrupt update activation. Such controls must never be enabled in a public production build.

## Critical acceptance scenarios

| ID | Scenario | Required result |
|---|---|---|
| T01 | Normal cash sale: 14.00 due, 20.00 tender | One sale/payment; 6.00 change; exact stock deduction |
| T02 | Double-click confirm | One local document and one canonical sale |
| T03 | Server commit succeeds, response is lost | Same UUID retry returns original; no second movement |
| T04 | Same UUID with changed total | 409; original preserved; visible review state |
| T05 | Cash sale while offline then reload | Locally committed sale/outbox/receipt survive normal reload |
| T06 | Storage quota/transaction abort | No success screen, no partial rows, cart preserved |
| T07 | Price changes while cart is open | Review before payment; completed permitted snapshot preserved |
| T08 | Offline replay exceeds current stock | Sale recorded with negative-stock exception; no disappearance |
| T09 | Two concurrent refunds of final unit | At most one succeeds; no over-refund/restock |
| T10 | Partial return rounding, then remaining return | Cumulative refund equals original, never exceeds it |
| T11 | Product edit/archive after sale | Historical receipt unchanged |
| T12 | Cross-store IDs / cashier calls manager endpoint | Rejected; no leaked cost or record existence |
| T13 | Shift close with pending/review sales | Close blocked; cash-count draft remains |
| T14 | Update available during checkout/pending outbox | No forced refresh; safe update deferred |
| T15 | Second writable tab / expired lease | Single writer; recovery uses same IDs |
| T16 | Card/PayNow selected offline | Disabled with reason; no “verified” status |
| T17 | No Background Sync API | Foreground/manual path fully functional |
| T18 | Browser storage cleared / first launch offline | Honest unavailable state; no fabricated catalogue/sales |
| T19 | Backup restored to isolated environment | Ledger/payment/receipt reconciliation passes |
| T20 | Print fails or user reprints | Sale retained; no duplicate sale |

The detailed CSV expands these scenarios with preconditions, steps, expected evidence and release stage. Traceability links requirements to tests and screens.

## Responsive and accessibility matrix

Test 390×844, 430×932, 768×1024, 1024×768 and 1440×900; keyboard-only; 200% zoom; touch; long names; reduced motion; screen-reader landmarks/focus; empty/loading/error states. Automated accessibility tools do not replace manual payment-dialog and receipt reading checks. A WCAG 2.2 AA goal is not a compliance certificate. [S07]

## Browser and hardware matrix

Desktop Chromium, Firefox and Safari; iOS Safari and installed home-screen mode; Android Chromium. Record exact versions and OS at execution. Service-worker/IndexedDB tests require HTTPS or trusted localhost. Safari/WebKit emulation does not prove actual iPhone standalone safe areas, OS suspension, installation or printer behavior. Mark those tests NOT RUN until verified on real devices.

Barcode baseline is a keyboard-wedge USB/Bluetooth scanner; test focus and scan suffix configuration. Camera scanner, silent ESC/POS printing, cash drawer and physical terminal integrations are outside the release claim.

## Release gates

G0: scope/ADRs and current dependency versions documented. G1: catalogue/stock domain tests pass. G2: online cash flow plus immutable history and refund invariants pass. G3: offline atomicity/idempotent recovery/update tests pass. G4: responsive/accessibility/security/backup rehearsal pass. G5: reviewer demonstration and README evidence are reproducible from a clean clone.

Block pilot release for duplicate transactions, lost locally acknowledged data in tested normal-reload scenarios, unauthorized refunds, incorrect cash totals, cross-store access, stale-price silent repricing, or unreviewed destructive migrations. Lower-priority cosmetic issues may ship only with explicit notes.

## Evidence format

Each test record contains test_id, git SHA, build ID, environment, browser/device, fixtures, expected/actual outcome, screenshot/log/report path and PASS/FAIL/NOT RUN. Never convert “planned” to “passed” because a document or screenshot exists. Performance reports state sample count and p95 calculation, not only a single fast run.
