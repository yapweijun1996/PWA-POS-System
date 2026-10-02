# Counter POS · PWA POS Design Kit
## Product specification, engineering contracts and visual handoff

**Version:** 1.0 · **Prepared:** 2 October 2026 · **For:** Yap Wei Jun  
**Status:** Proposed implementation baseline, not a deployed or production-certified POS.  
**Working name:** Counter POS. Branding, repository name and software license are not approved or trademark-cleared.

中文：这是一套可交给 AI Agent 或开发者执行的完整设计文档，不是已开发完成的收银系统。先打开 `START-HERE.html` 查看文档导航、线框图和视觉稿；本地交互示例在 `prototype/index.html`。示例不连接数据库、不收款、不提供真实离线同步。

## Start here

| Need | File |
|---|---|
| Browse the complete kit | [START-HERE.html](START-HERE.html) |
| Understand the proposal in Mandarin | [中文导读](docs/00-zh-CN-overview.md) |
| Read the complete specification | [Product and Engineering Handbook](pdf/PWA-POS-Handbook.pdf) |
| Review the visual direction | [UI Design Atlas](pdf/UI-Design-Atlas.pdf) |
| Try product selection, cart and simulated checkout | [Local interaction prototype](prototype/index.html) |
| Implement the project | [AI Agent implementation brief](prompts/IMPLEMENTATION-TASK.md) |
| Inspect API / schema | [OpenAPI](specs/openapi.yaml) · [PostgreSQL reference schema](specs/schema.sql) |
| Check what was actually validated | [Delivery validation](validation/REPORT.md) |

## Product in one sentence

A lightweight, responsive POS and stock ledger for a small retailer, with a deliberately bounded offline cash-selling workflow and an optional future ERP adapter.

The intended V1 covers product maintenance, stock receipts and adjustments, a fast product-to-cart flow, one payment method per sale, receipts, online manager-controlled returns, daily summaries and shift close. The main evidence for a portfolio should be reliable transactions, understandable UX and reproducible failure-recovery tests—not a long list of unimplemented features.

## Important boundaries

- **Design baseline, not approval:** the proposed stack is React + TypeScript + Vite, Fastify, PostgreSQL and IndexedDB through Dexie. Versions must be pinned and compatibility checked when implementation begins.
- **Offline is bounded:** after online enrollment, login, catalogue download and shift opening, cash sales can be stored locally under a valid offline permit. First login, product/stock administration, refunds and final shift close require connectivity.
- **Electronic payments:** Card and PayNow are manually recorded external payments in V1, online only. A cashier's entry is not provider verification. There is no gateway, terminal SDK, automatic settlement or bank-confirmed webhook in this kit.
- **Demo versus real use:** all products, receipts and dashboard data are synthetic. The included HTML is an in-memory interaction prototype; refreshing resets it. Do not use it to operate a shop.
- **Taxes:** the sample store has tax disabled. No SG/MY tax registration, tax rate, receipt or e-invoicing compliance is claimed.
- **No infrastructure changes:** this delivery does not create a GitHub repo, modify an existing project, deploy services or connect to Globe3.

## Reading order

Read product requirements → business rules → screens/design system → architecture/offline sync → database/API → security/testing → implementation/deployment. The source register separates verified platform facts from new design decisions. When artefacts disagree, follow `docs/15-decisions-risks.md` rather than inferring behavior from a screenshot.

## Delivery layout

`docs/` contains editable Markdown. `pdf/` is the reading edition. `design/` contains PNG screens, SVG/PNG wireframes, diagrams and design tokens. `specs/` contains machine-readable contracts and synthetic fixtures. `prototype/` is the local interaction study. `prompts/` provides the engineering handoff. `validation/` states the checks performed on this bundle.

Extract the ZIP before opening HTML so relative images and links resolve. No package installation, CDN or account is needed to browse the kit. Use a modern browser. A PWA implementation will need HTTPS or a trusted local development origin; simply opening this design prototype does not install a PWA. [S02]
