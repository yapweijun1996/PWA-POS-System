# 05 · Architecture and module boundaries

> 中文重点：一个清楚的模块化系统比很多微服务更适合这份 portfolio。

## Proposed stack and rationale

Use a TypeScript modular monolith: React + Vite for the client, Fastify for the HTTP API, PostgreSQL for durable server state and Dexie as an IndexedDB convenience layer. Share pure money and validation contracts through a separate domain package. Vite and Fastify have official getting-started/API documentation; pin compatible supported versions at implementation kickoff rather than copying an unverified “latest” version into this plan. [S10, S11, S12]

This stack is a recommendation, not a statement about the user's existing proficiency or a repo already created. A CFML backend could implement the same contracts; the portfolio proposal uses TypeScript to demonstrate another delivery environment. Do not add microservices, Kafka, Redis or an AI dependency unless a measured problem justifies them.

## Runtime boundary

The browser renders views, stores a bounded catalogue snapshot and holds locally committed sales awaiting acknowledgement. The service worker caches the shell and versioned static assets; it does not intercept and blindly replay arbitrary POST requests. The foreground sync worker drains the explicit outbox. The API authenticates, validates and posts domain commands. PostgreSQL owns sale/stock/audit truth. An integration outbox later delivers ERP events after local business commits.

Serve the application and `/api` behind one HTTPS origin to simplify secure cookies and avoid cross-origin authentication complexity. The API and database remain private behind the reverse proxy/network. Public demo uses a separate environment and synthetic data. Static GitHub Pages may host docs or a browser-only demo; it is not a Node/PostgreSQL host. [S08]

## Code structure: implementation target

```text
apps/
  web/src/{app,features,components,db,sync,pwa,i18n}
  api/src/{plugins,modules,jobs}
packages/
  domain/{money,pricing,sales,returns,inventory}
  contracts/{schemas,errors,events}
  fixtures/
infra/{compose,proxy,migrations,backup}
docs/{adr,runbooks,qa}
tests/{unit,integration,e2e,fixtures}
```

Feature modules: auth/device, catalogue, inventory, sales, refunds, shifts, reporting and sync. Views never write SQL or calculate authoritative refunds. API routes delegate to application services. Services use repositories inside an explicit transaction boundary. Share pure calculations but do not expose server-only secrets in frontend bundles.

## Server posting transaction

Authenticate operator and terminal → enforce store context → look up stable client_sale_id → compare canonical payload hash → validate price revision/permit and totals → lock shift and stock balance rows in product-ID order → insert immutable sale, lines and one payment → append stock movements and update balances → append audit and optional domain event → commit → return canonical receipt and acknowledgement cursor.

The stable unique key handles concurrent duplicate attempts; use transaction retries for recognized serialization/deadlock errors. Never perform a payment-provider call or wait for a human while holding database locks. PostgreSQL row locks last until transaction end and consistent lock ordering reduces deadlock exposure. [S06]

If the response is lost after commit, an identical request returns the existing result. Idempotency records must remain available as long as old offline documents can be replayed. The permanent sale unique key is the final defense; a short-lived request cache alone is insufficient.

## Query and data shaping

Catalogue bootstrap is paginated/versioned and excludes product cost for cashiers. Reporting endpoints aggregate server-posted rows by business date and return pending-local counts separately where the client supplies local status. Use cursor pagination for sales/ledger; no unbounded download to render a single screen. Store images as external object keys or controlled relative assets, not enormous base64 values in product rows.

## Failure isolation

A printer, report export or future ERP delivery failure cannot reverse a posted sale. Failed sync retains its payload. Failed local storage blocks checkout. A server outage leaves the cached, authorized cash workflow available but disables admin mutations. Invalid authentication stops network posting; reauthentication resumes the same outbox documents. Do not retry by making a new ID.

## Trust boundaries

The browser is untrusted. Prices, stock, role, client time and “payment verified” booleans are validated against server policy. Offline authorization is a limited business risk decision, not server-equivalent security. Browser storage has quota and deletion limits; persistence APIs reduce some risks but do not make it a backup. [S04]
