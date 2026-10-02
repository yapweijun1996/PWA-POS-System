# 14 · GitHub portfolio and demonstration

> 中文重点：展示真实能力，不把设计图当作已经完成的应用。

## Repository presentation

Suggested repo slug is `pwa-pos-system`; it has not been created. Describe the eventual app as “A lightweight PWA point-of-sale and inventory ledger with a bounded offline cash workflow.” Keep the name and license pending until reviewed. Pin screenshots, architecture, setup, data reset procedure, test evidence, limitations and a demo link only after that link exists.

A credible README contains: problem and scope, capability status table, a short demo sequence, actual stack/versions, architecture and tradeoffs, local setup, migrations, tests, failure recovery, security boundary and roadmap. Do not imply experience with a technology merely because a generated scaffold imports it; explain the decisions and code you can defend.

## Five-minute demonstration script

1. Explain single-store scope and show the product/stock distinction. Create a synthetic item and receive a quantity.
2. Sell the canonical 14.00 basket, take 20.00 cash, show 6.00 change, open receipt and inventory movement.
3. Show the pending-local label while disconnected, then restore connectivity and demonstrate replay of the same UUID.
4. Drop a server response after commit in the test harness and prove no duplicate stock deduction.
5. Return one item with manager permissions, show linked history and close a reconciled shift.

The included HTML prototype supports only the interaction study: product selection, search/category, cart quantities, a simulated cash payment and visual navigation. It is not this complete demo script and has no backend/IndexedDB/PWA guarantee.

## Synthetic store

Sample store name: Everyday Store. Sample cashier: Alex. Currency SGD; tax disabled. Twelve generic products with original vector illustrations; no retailer data or endorsement. The default basket is 2 Cold Brew, 1 Oat Cookies and 1 Sparkling Water, totaling 14.00. Dashboard sample is a separate synthetic daily dataset: 36 orders, gross 486.00, refunds 18.00, net 468.00. Do not present these as collected shop performance.

## Resume language: only after implementation evidence

Possible completed-project statement: “Built a responsive POS and stock ledger using TypeScript and PostgreSQL; implemented idempotent sales posting, role-controlled refunds and a tested IndexedDB outbox for bounded offline cash sales.” Add numerical performance or reliability results only after measuring them.

For the present delivery, accurate language is: “Prepared a PWA POS product/engineering specification and interactive UI study covering transaction integrity, offline recovery and inventory-ledger design.”

## Reviewer questions to prepare

Why not localStorage? Why separate sale and sync state? How is duplicate replay prevented? What happens when money was accepted offline but stock changed? How does a partial refund handle a rounding remainder? Why is a local payment label not bank confirmation? Why are server and pending-local report totals separated? How is a new service worker prevented from erasing a current sale?

## Public release hygiene

Only synthetic fixtures. No passwords, full bank references, real customer contacts or employer source code. Choose a license intentionally; keep third-party notices. A visual mockup can be published as a design concept, but clearly label its non-implemented states.
