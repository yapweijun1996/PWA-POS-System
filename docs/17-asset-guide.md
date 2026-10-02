# 17 · Asset guide and handoff conventions

## Visual assets

`design/screens/` contains deterministic browser-rendered high-fidelity PNG studies for desktop, tablet, mobile, payment, receipt and back-office states. `design/wireframes/` contains grayscale SVG sources and PNG exports. `design/diagrams/` contains architecture, entity relationship and transaction/sync diagrams with editable sources. `design/tokens.*` expresses the canonical color/spacing/type direction.

The generated exploratory poster in `design/concepts/` is included for provenance only. It is not a chosen brand, app license, verified architecture, legal tax setup or supported payment integration. Its generated text is not a specification. Use the deterministic screens and business contracts for implementation.

## Local HTML study

`prototype/index.html` is a dependency-free, in-memory UI study, not the proposed React implementation. It supports navigation, search/category filtering, add/remove quantity, mobile cart, cash tender/change, simulated receipt and an offline-status simulation. Offline switch means visual simulation only. It does not use IndexedDB, a server, a payment provider, a real service worker or a production login. Data resets on refresh by design.

Open the extracted HTML directly in a browser. Screenshot mode is available with query parameters documented in the prototype source; images were generated from these same layouts to reduce handoff ambiguity. Visible demo disclosures must remain when the study is shown publicly.

## Editing and import

SVG files can be edited in a vector editor that supports SVG; exact import behavior is editor-dependent and has not been certified for Figma. PNGs are previews. There is no `.fig` file and no bundled commercial font. Original vector product illustrations are illustrative placeholders, not product photography.

Markdown is the editable text source. The PDFs are reading editions. OpenAPI/SQL fixtures are reference contracts that need their own application and database tests. Read `validation/REPORT.md` before interpreting PASS labels.

## Handoff checklist

The implementing Agent reads README, business rules, offline sync and security before coding. Confirm target repo and environment; inspect uncommitted work; preserve the owner's files. Treat generated source as reviewable scaffolding, not trusted production code. Keep source-of-truth documents, contracts, tests and screenshots aligned in each PR.
