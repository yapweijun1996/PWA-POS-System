# 08 · API and integration boundary

> 中文重点：API 是开发合约，不代表这些 endpoint 已经部署。

## Contract files

`specs/openapi.yaml` uses OpenAPI 3.1.0 deliberately as an interoperability baseline, not a claim that it is the newest specification. It describes V1 resources, required fields and common errors. [S13] `specs/example-sale.json` is a synthetic valid cash command. The API and UI use the same bounded integer money rules, but the server recalculates all values.

## Authentication and security

The production app and API share an origin. Use a Secure, HttpOnly, appropriately SameSite session cookie, short-lived server sessions, CSRF protection on mutations and role checks at every handler. Example cookie name is `counter_session`. Obtain a CSRF token through the authenticated bootstrap; do not place access/refresh tokens in localStorage. Never put an admin key in Vite public environment variables. Session controls and fixation prevention follow the OWASP guidance referenced in [S09].

All paths are prefixed `/api/v1`. The authenticated session determines store scope; resource IDs from another store return not-found/forbidden without revealing metadata. Parameterized SQL and bounded pagination are mandatory.

## Endpoint groups

| Group | Operations | Authorization |
|---|---|---|
| Session | POST login/logout; GET bootstrap | Public login; authenticated remainder |
| Catalogue | GET products/categories; POST/PATCH products | Cashier read projection; manager write |
| Inventory | GET balances/ledger; POST receipts/adjustments | Manager writes |
| Shifts | POST open; GET current; POST count/close; cash movement | Cashier own shift; manager review |
| Sales | POST frozen sale; GET list/detail; receipt data | Cashier within allowed scope |
| Refunds | POST linked refund; GET refund detail | Manager, online only |
| Sync | GET catalogue changes; GET status/probe | Registered authenticated terminal |
| Reporting | GET daily summary | Manager |

The reference OpenAPI deliberately includes the core implementation surface. Explicitly documented later ERP connectors, payment gateways and advanced reports are not claimed as implemented endpoints.

## Idempotency, preconditions and errors

Sale/refund creation requires an Idempotency-Key matching the frozen client document UUID. Posting retries must be byte-equivalent after canonicalization. Do not mix a new request body with a reused key. Product and inventory mutations use expected_version; stale updates return 409 VERSION_CONFLICT.

Standard error shape is `{code, message, request_id, retryable, details}`. Codes include VALIDATION_ERROR, AUTH_REQUIRED, FORBIDDEN, STORE_MISMATCH, SHIFT_NOT_OPEN, STOCK_UNAVAILABLE, OFFLINE_PERMIT_INVALID, IDEMPOTENCY_CONFLICT, VERSION_CONFLICT, REFUND_LIMIT, NEEDS_REVIEW, RATE_LIMITED and SERVICE_UNAVAILABLE. Field errors point to stable JSON paths. Log request IDs but not secrets.

401 requires reauthentication; 403 requires manager/policy review; 409/422 requires review rather than blind retry; 429 honors Retry-After; 5xx retries the same document. A timeout has unknown outcome: query/retry using the original key, not “create again”.

## Sale response and reconciliation

A success response returns sale_id, client_sale_id, receipt_no, posted_at, business_date, total_minor, sync_cursor and any review_flags. Return 201 for a new committed sale and 200 for an identical replay. A receipt is exposed only after commit. Canonical sales are immutable; refund creates another resource.

## Input validation and limits

Strings have explicit max lengths; input names are text, not HTML. Query page size is 1–100. Sale lines are 1–100 with whole-unit quantity 1–999. Reject additional properties on money-sensitive command objects unless explicitly versioned. Reject duplicate line IDs and incompatible currency. API payload cap is a proposed 256 KiB per sale command; images upload separately with validated file type and dimensions.

## Compatibility policy

Include schema_version in frozen offline payloads. Support the previous offline schema for the maximum permit window plus recovery grace; migration/deprecation decisions belong in an ADR. Never deploy a backend that rejects all queued documents from the previous client without a reconciliation path. Price revision tombstones remain readable for history even after a product is archived.

## Examples

The canonical demo is four units across three lines, due SGD 14.00, tender SGD 20.00, change SGD 6.00. No tax or discount. Client-generated UUIDs in the fixture identify synthetic data only. A real client must generate its own stable IDs once and persist them before retries.
