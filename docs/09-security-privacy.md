# 09 · Security, privacy and recovery

> 中文重点：这不是合规认证。先确保权限、历史数据和本机待同步销售不会被误处理。

## Threat model

Assets: transaction history, stock ledger, cashier identity, local pending sales, database backups and server credentials. Threats: stolen/shared terminal, malicious browser input, XSS, CSRF, replay/duplicate commands, cross-store object access, client price tampering, server outage, local storage loss and accidental destructive maintenance.

V1 has one store per deployment, but identifiers remain store-scoped. A public portfolio demo is a separate security domain with synthetic data and no access to real shop/ERP credentials. Do not infer consent to copy Globe3 customer data into GitHub.

## Authorization matrix

| Capability | Cashier | Manager |
|---|---|---|
| Browse selling catalogue / perform own-shift sales | Yes | Yes |
| View product cost / receive or adjust stock | No | Yes |
| Override discount beyond cashier permit | No | Online approval only |
| Refund / export recovery / backup restore | No | Yes, online |
| Close own reconciled shift | Yes, within policy | Yes |
| Change currency/tax/device policy | No | Yes, with audit |

Server checks role and scope on every operation, including direct API calls. Hiding a button is not authorization. Protect cost fields by response projection, not only CSS.

## Session and device controls

Use HttpOnly secure cookies, rotate session identifiers on sign-in/privilege change, enforce inactivity/absolute lifetimes and revoke server sessions on logout. Protect mutation requests from CSRF and authenticate WebSocket/event channels if later introduced. [S09]

Passwords are stored with an established adaptive password hashing library; rate-limit login and require manager recovery procedures. Avoid shared universal PINs. Device enrollment and offline permissions are named and revocable. A local lock screen is a convenience boundary on a trusted device, not equivalent to OS-level encryption or remote revocation.

## Browser data

Cache the app shell separately from authorized business data. Do not cache authentication responses in the service worker. Offline catalogue excludes costs/customer PII by default. Clear eligible cached data on explicit logout only after unresolved sales are synchronized or securely exported; otherwise lock access and require manager intervention rather than deleting evidence.

Use a restrictive CSP, escape imported text, validate image uploads and avoid remote script CDNs. Client-side encryption with a key stored alongside data does not solve a compromised-browser threat; document key management before claiming encrypted offline storage. Browser persistence is not a backup. [S04]

## Payment boundary

V1 records cash and external payment acknowledgements; it does not handle cardholder account data. Do not build a card-number form or imply PCI compliance. A bank/payment-gateway integration requires a separate provider contract, webhook signature checks, event deduplication, settlement reconciliation and a revised threat model. The UI prototype never transfers money.

## Audit and observability

Append actor/device/time/action/subject/reason/request ID for stock, product pricing, discount exceptions, refunds, shift close and security changes. Redact cookies, passwords, permits and payment references from logs where unnecessary. Log an offline exception's UUID and reason without logging its entire payload publicly.

Alert on unresolved outbox items, repeated idempotency conflicts, negative balances, backup failures, long-open shifts and high authentication failure rates. These are proposed operational alerts, not automations created by this delivery.

## Backup and restore

Back up PostgreSQL with an established logical or physical backup process, encrypt at rest/in transit, separate credentials and store a copy off the application host. Include uploaded product media and migration/build metadata. Database backups do not contain transactions still present only on a disconnected browser.

Suggested project targets: daily backup and a verified restore rehearsal before any pilot. An RPO/RTO target is not achieved until measured. Restore into a separate database/environment, run schema and financial/stock reconciliation checks, verify identities and only then schedule a controlled cutover. Never overwrite a live database as a troubleshooting shortcut.

## Public release guardrails

No real people, live receipts, credentials, IP addresses or internal infrastructure details in the public repo or screenshots. Secret-scan commits and built frontend assets. Choose a project license after review; this kit deliberately makes no MIT-license assertion for the eventual app. The exploratory image's generated license badge is not authoritative.
