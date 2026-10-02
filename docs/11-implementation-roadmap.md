# 11 · Implementation roadmap and work breakdown

> 中文重点：按可验收的阶段开发，不给没有依据的“完成百分比”。

## Delivery sequence

| Stage | Outcome | Dependencies | Exit evidence |
|---|---|---|---|
| M0 · Contract | Agree scope, ADRs, target environment and fixtures | This kit | Reviewed assumptions; repo/branch identified |
| M1 · Foundation | App/API scaffolds, auth, shared money, migrations, CI | M0 | Clean build; unit tests; empty DB migration |
| M2 · Catalogue | Products, price revisions, receive/adjust ledger | M1 | Duplicate/stale update tests; stock reconciliation |
| M3 · Online sale | Cart, cash tender, posting, receipt and sales detail | M2 | T01–T04, T11, T20 integration evidence |
| M4 · Returns/shift | Manager refunds, cash in/out, count/close | M3 | Refund concurrency and cash reconciliation |
| M5 · Offline PWA | Permit, local atomic sale, outbox, replay, update UX | M3/M4 | Fault-injected T05–T08, T14–T18 |
| M6 · Portfolio | Overview, responsive polish, docs, clean demo deploy | All | Clean-clone run, actual browser/device matrix |

Do not estimate calendar completion without inspecting the selected repo, implementation team and available environments. These stages are work order, not a promise of background development.

## Suggested tickets

ENG-01 initialize workspace and CI; ENG-02 authentication/role projection; ENG-03 money and tax tests; ENG-04 schema/migration; ENG-05 products/pricing; ENG-06 stock movement service; ENG-07 cart and barcode; ENG-08 cash checkout and atomic posting; ENG-09 idempotent replay; ENG-10 receipts and browser print; ENG-11 refunds and cumulative allocation; ENG-12 shifts and cash movement; ENG-13 offline permit/readiness; ENG-14 IndexedDB commit and writer lease; ENG-15 push/pull sync and stock watermark; ENG-16 service-worker update/migration; ENG-17 dashboards and export; ENG-18 responsive/a11y; ENG-19 security and restore drill; ENG-20 demo evidence and README.

Each ticket states in-scope files/modules, invariants, tests, migration impact, screenshot states and rollback concerns. Agents should not independently implement competing money algorithms or duplicate a shared schema package.

## Agent collaboration

Architect freezes contract deltas; Developer implements a narrow vertical slice; Reviewer checks business invariants and diff; QA executes independent replay/device scenarios. Roles may be handled by separate runs, but independence must not be invented. A self-authored test is not a third-party audit.

Inspect `git status`, branch and uncommitted work before editing. Create a feature branch/worktree without resetting the owner's changes. Keep commits reviewable. Do not auto-merge, deploy, rotate credentials or touch Globe3 without task-specific authorization. The implementation prompt in this kit is a handoff, not permission to execute it on an unknown machine.

## Development shortcuts that are acceptable

Use synthetic fixture images and a seeded demo store; keep styling dependency-light; use an ordinary browser print dialog; defer sophisticated customer management. Build one store well before designing a hosted multi-tenant billing platform.

## Shortcuts that are not acceptable

No “stock = stock − qty” outside a posting transaction; no localStorage-only sales store; no live payment claim for a manual selector; no SQL in UI components; no fixed shared admin password; no service-worker forced reload during payment; no pretending a browser-only demo has a durable backend.

## Documentation maintenance

Update OpenAPI, SQL, business rules and fixtures in the same PR when behavior changes. ADRs record the reason and affected tests. Regenerate screenshots from the implemented build, then replace this kit's visual-study images only when they represent actual behavior. Maintain a visible “planned / implemented / verified” capability table in the eventual repo.
