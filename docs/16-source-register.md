# 16 · Source register and provenance

**Checked:** 2 October 2026. Platform behavior may change; recheck supported versions at implementation and release. These sources support specific platform facts, not the entire proposed POS architecture. All writing and vector wireframes in this kit are newly authored; no Odoo code or product screenshots are copied.

| ID | Primary reference | What it supports / limitation |
|---|---|---|
| S01 | [Odoo 19 POS](https://www.odoo.com/documentation/19.0/applications/sales/point_of_sale.html) and [Workflow](https://www.odoo.com/documentation/19.0/applications/sales/point_of_sale/use.html) | Search-visible official descriptions of browser POS and daily workflow. Full page fetch timed out during this session; no claim to have audited Odoo internals, exact storage or payment code. |
| S02 | [MDN: Using Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers) and [web.dev: Update](https://web.dev/learn/pwa/update) | Secure-origin lifecycle and cache/update concepts. Safe checkout deferral is this project's design decision. |
| S03 | [MDN: Background Synchronization API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API) | Limited browser availability; optional background synchronization. |
| S04 | [MDN: Storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) and [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/) | Quotas, estimates, eviction and persistence caveats. No zero-loss promise. |
| S05 | [MDN: IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) | Transactional browser storage for structured data. |
| S06 | [PostgreSQL: Explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) | Row-lock lifetime, conflicts and consistent lock ordering. |
| S07 | [W3C: WCAG 2.2 target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) | 24px minimum criterion and exceptions; our 44px target is a stricter design choice. |
| S08 | [GitHub Docs: What is GitHub Pages?](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) | Static hosting distinction. |
| S09 | [OWASP: Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) | Secure session lifecycle and cookie considerations. |
| S10 | [Vite: Getting Started](https://vite.dev/guide/) | Client build tooling and templates; no version pin chosen by this kit. |
| S11 | [Fastify documentation](https://fastify.dev/docs/latest/) | Proposed API framework reference. |
| S12 | [Dexie: Getting Started](https://dexie.org/docs/Tutorial/Getting-started) | Library entry point; Dexie Cloud is not selected or required. |
| S13 | [OpenAPI 3.1.0](https://spec.openapis.org/oas/v3.1.0.html) | Machine-readable API contract format; intentionally not described as latest. |

## Private source: applied house standard

K01: KB-MCP skill `pwa:product-standard`, version 1.0.0, exact reference `270d896a-12b0-40b4-856f-f6274d872c95:3f932f5e-8bc9-40c6-86e9-e676d47e1c52`, read in this session. Applied requirements: opaque app chrome, safe areas, explicit user-controlled worker updates with loading feedback, versioned caches, defined offline contract, mobile/accessibility QA and no “manifest means done” claim. No unrelated private project details were included.

The initial bounded context assembly exceeded its response budget; the narrower memory read and exact skill fetch supplied the relevant PWA standard. No confirmed existing PWA POS repository or approved brand was retrieved.

## Provenance labels

“Requirement” originates in the user's brief; “proposed decision” is new design guidance; “platform fact” refers to the sources above; “synthetic” means invented sample data; “validation result” refers only to executed bundle checks. Images are a visual study, not screenshots of a deployed application.
