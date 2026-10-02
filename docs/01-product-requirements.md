# 01 · Product requirements

> 中文重点：先完成小店的一天，而不是把所有 ERP 模块搬进来。

## Intent and evidence

The user requested a standalone PWA POS portfolio project on GitHub, intended for small businesses with a small catalogue and a good design. This kit is a proposed response to that brief. Odoo documentation is a workflow reference, not evidence that its source code or offline protocol was audited. Its browser-based POS positioning and daily operational workflow inform the broad product categories only. [S01]

## Personas and jobs

| Persona | Job | Design consequence |
|---|---|---|
| Cashier | Sell a few items quickly and recover from mistakes | Large product targets; persistent total; minimal checkout fields |
| Owner / manager | Maintain stock, verify sales and close a shift | Separate back office; accountable adjustments; transparent sync exceptions |
| Portfolio reviewer | Understand the system in minutes | One-click synthetic demo, visible architecture and reproducible tests |

## Scope baseline

Single business per deployment; one store and stock location; one active selling device and one writable POS tab. Multiple owner/cashier users may exist, but there is one open cash shift at a time. Stock is tracked in whole units only. The initial dataset contains 12 synthetic convenience-store products; benchmark fixtures expand to 500 products. This is a planning boundary, not a tested maximum.

One currency is selected at setup (SGD in examples; MYR is another proposed configuration). Freeze currency after the first posted transaction. Tax is off in sample data. A configurable exclusive tax calculation may be enabled only after the owner verifies applicable treatment; statutory fiscalization and e-invoicing are outside V1.

## Functional requirements

| ID | Requirement | Release |
|---|---|---|
| FR-01 | Online sign-in, roles, registered terminal, open cash shift | V1 |
| FR-02 | Create/edit/archive products, unique SKU/barcode, categories, price history | V1 |
| FR-03 | Receive stock and post reasoned adjustments to an immutable ledger | V1 |
| FR-04 | Product search, category chips, keyboard-wedge barcode input | V1 |
| FR-05 | Cart quantity, remove/undo, locally held carts, line discount with permission | V1 |
| FR-06 | Cash tender/change; one manually recorded external method per online sale | V1 |
| FR-07 | Receipt, sale history and manager-authorized online partial/full refunds | V1 |
| FR-08 | Local atomic sale persistence, durable outbox, idempotent posting and visible recovery | V1 |
| FR-09 | Daily gross/net sales, refunds, orders, average ticket, low stock | V1 |
| FR-10 | Shift cash count, variance reason, final close only after reconciliation | V1 |
| FR-11 | Installable shell, user-controlled updates, responsive accessible interaction | V1 |
| FR-12 | Backup/restore runbook, audit trail, CSV export and isolated demo | V1 |
| FR-13 | ERP adapter contracts without dependence on an ERP | Later |

Do not implement split tender, customer debt, loyalty, restaurant tables, kitchen printing, weighed products, product variants, multi-store inventory, purchase orders, accounting, ecommerce, automatic card processing, PayNow verification or AI agents inside checkout in V1. Keep their extension points without showing dead buttons in production.

## User journeys

**Owner setup:** create store → select currency/timezone → verify tax-off default → create categories/products → receive opening stock → create cashier → enroll device.

**Cashier day:** sign in online → verify catalogue/device → open shift with float → search/scan/tap → review cart → enter tender → confirm physical cash → durable save → show receipt → continue selling → count cash → synchronize → close.

**Failure recovery:** sell cash offline under valid permit → show local receipt and pending badge → reconnect/re-authenticate as necessary → resend identical document → obtain canonical receipt → reconcile local pending adjustments → resolve exceptions without deleting evidence.

## Success criteria: targets, not measurements

The eventual implementation should let a new tester complete a three-product cash sale without training, recover an acknowledged local transaction after a normal reload, and retry a server-committed sale without duplication. Proposed performance budgets: local add-to-cart p95 below 100 ms for 500 cached products; search response below 150 ms; warm shell usable within 2 seconds on the declared test device. Measure with browser/version/hardware, dataset, network profile and run count in the report; do not publish an unsupported badge.

## Definition of ready for development

Record the target environment and repository, accepted scope exceptions, dependency lockfile policy, screenshot sizes, risk owner, payment boundary and release gates. The temporary project name and styling can change independently of domain behavior.
