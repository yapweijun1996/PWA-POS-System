# 15 · Decision log, assumptions and risk register

> 中文重点：这里区分用户明确要求、这次建议和仍然待确认的事项。

## Evidence and precedence

The user's confirmed requirements are: standalone PWA POS, GitHub portfolio value, small catalogue, sales/inventory essentials and strong design; then a full documentation ZIP with images, wireframes and design. All more specific choices below are proposed baselines, not claimed user approvals.

Authority order: accepted future change request → business rules and API contract → database service invariants → screen specification/design tokens → wireframes → rendered mockups → exploratory AI image. Resolve conflicts in an ADR and update linked tests; do not treat decorative text in a concept poster as an API contract.

## Proposed decisions

| ADR | Decision | Reason / consequence |
|---|---|---|
| ADR-01 | Standalone single-store modular monolith | Small scope; fewer distributed failure modes |
| ADR-02 | One active selling device in V1 | Bounds offline stock and cash-session complexity |
| ADR-03 | Cash-only offline; external methods recorded online | Avoid false electronic-payment verification |
| ADR-04 | Local atomic outbox + server UUID/hash dedup | Recover retries without duplicated business effects |
| ADR-05 | Stock ledger plus transactional balance projection | Auditable history with fast read performance |
| ADR-06 | Integer minor-unit money; exclusive tax only, sample tax off | Deterministic sums; no implied tax compliance |
| ADR-07 | Online manager refunds; immutable completed history | Traceable correction and bounded authorization |
| ADR-08 | Foreground sync is baseline; Background Sync optional | Browser portability [S03] |
| ADR-09 | Same-origin cookie auth; bounded signed offline permit | Clear server/browser trust boundary |
| ADR-10 | Explicit safe-time service-worker activation | Prevent interruption or migration loss [K01] |
| ADR-11 | React/TS/Vite + Fastify/PostgreSQL/Dexie proposal | Shared contracts and portfolio learning; version review needed |
| ADR-12 | POS header fixed; long admin pages may hide/reveal | Documented exception to smart-header default [K01] |
| ADR-13 | Light theme only in V1; preserve user zoom | Keep tested design manageable and accessible |
| ADR-14 | No actual payment/ERP integration in this release | Honest delivery boundary |

## Open decisions before coding

Approve or replace working brand/repo, target hosting machine, actual package versions, required browsers/physical printer, cashier discount ceiling, offline-permit limits, tax/legal settings, data retention and project license. Defaults are already supplied so design work can proceed; implementation must record how these were resolved without inventing approvals.

## Risk register

| Risk | Impact | Mitigation | Release disposition |
|---|---|---|---|
| Browser storage eviction/device loss | Unuploaded sales lost | Readiness test, storage monitoring, fast sync, recovery export | Residual risk disclosed |
| Duplicate retry / multi-tab race | Double sale or stock deduction | Stable IDs, unique keys, transaction tests, writer lease | Blocking if untested |
| Price/stock change while offline | Variance after money accepted | Historical snapshots, permit scope, exception reconciliation | Controlled, not hidden |
| Manual payment mislabelled verified | False revenue assurance | Explicit labels; external reference; no gateway claim | Blocking UI defect |
| Refund race / rounding drift | Over-refund | Locked cumulative entitlement tests | Blocking financial defect |
| Update interrupts transaction | Corruption/lost work | Waiting-worker UX and migration/recovery tests | Blocking lifecycle defect |
| Public demo reaches live services | Privacy/financial exposure | Isolated data/credentials; no real integrations | Blocking security defect |
| Scope grows into ERP | Incomplete project | Stage gates and explicit deferred scope | Reject unreviewed additions |
| License/brand assumption | Misrepresentation | Working identity; no app license assigned | Resolve before public release |

## Honest completion model

A documentation bundle can be complete while application development has not begun. Report artefact generation/validation separately from production software readiness. No arbitrary overall project percentage is assigned here.

## Implementation follow-up — 2 October 2026

The authorized local implementation is now recorded in `docs/adr/001-v1-implementation.md`. That ADR resolves implementation defaults and documents contract differences; the working name, license, physical hardware and production environment remain open. Actual evidence is in `docs/qa/REPORT.md`. Earlier chapters and PDFs describe the original design baseline rather than the runtime's verified status.
