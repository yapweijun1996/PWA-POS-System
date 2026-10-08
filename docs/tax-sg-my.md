# Tax notes: Singapore (GST) and Malaysia (SST)

Counter POS is designed for **both Singapore and Malaysia**. Keep this in mind for every receipt, price and total decision.
Status: research notes as of 2026-10-07. Not legal advice. Items marked UNVERIFIED were not read on an official page.

## Singapore: GST

| Item | Finding | Confidence |
| --- | --- | --- |
| Rate | 9% (IRAS current-rate page; an older IRAS guide still says 7%, stale) | High |
| Registration threshold | S$1m taxable turnover, retrospective (past calendar year) or prospective (next 12 months); register within 30 days | Medium (Stripe summary; IRAS page not opened) |
| Price display to consumers | Must be GST-inclusive | Medium (Stripe summary; IRAS page returned 404) |
| Simplified tax invoice | Allowed when total is S$1,000 or less incl. GST; must show invoice number, date, supplier details, description, total payable incl. GST, and the line "Price Payable includes GST" | Medium (IRAS summary) |
| Record keeping | At least 5 years; electronic records allowed with controls | High (IRAS guide, 30 Jan 2026) |
| InvoiceNow | Mandatory in stages from 1 Apr 2028 by annual supplies | Medium (KPMG, Fonoa) |
| Cash rounding to 5 cents | Common practice; UNVERIFIED here | Low |

A shop below the threshold may not be GST-registered at all, so GST must be **configurable per store**, not hardcoded.

## Malaysia: SST (there is no GST)

Malaysia replaced GST with SST in 2018. Do not apply a "GST" label or rate to Malaysian stores.

| Item | Finding | Confidence |
| --- | --- | --- |
| Sales tax | 5% / 10% on goods | Low-medium (commercial sites) |
| Service tax | Mostly 8%, some categories 6%; scope widened 1 Jul 2025 | Low-medium |
| Registration threshold | RM500,000 | Low-medium |
| E-invoicing (B2C retail) | Issue normal receipts, then one consolidated e-invoice within 7 days after month end; buyer may request an individual e-invoice in the same month (LHDN Specific Guideline v4.9, 7 Sep 2026) | High |
| E-invoicing phase dates | Sources conflict (see the Decision Brief); confirm with LHDN | Conflicting |

## What this means for Counter POS

Current V1 (docs/01-product-requirements.md): tax is off by default; an optional **exclusive** tax calculation may be enabled; fiscalisation and e-invoicing are out of V1.

Gaps against SG and MY use:

1. **Tax mode per store:** off, inclusive, or exclusive. Singapore consumer retail needs **inclusive** (the shelf price is the price paid); V1 offers only exclusive.
2. **Tax label and rate per store:** "GST 9%" for Singapore, "Sales tax" or "Service tax" for Malaysia, with the rate set by the owner after verifying treatment.
3. **Receipt breakdown:** per receipt and per line, show tax amount and "Price Payable includes GST" where required; store the breakdown immutably with the sale.
4. **Mixed rates:** Malaysia can have 5%, 10%, 6% and 8% in one shop; support a tax code per product, not one store rate.
5. **Rounding:** decide cash rounding (Singapore 5 cents) as a written rule before building; refund rounding must mirror it.
6. **Export:** a daily summary with tax totals by code, usable later for InvoiceNow (Singapore) and consolidated e-invoice (Malaysia).
7. **UI text:** the Sell screen currently shows "Tax off"; make it reflect the store's configured mode.

## Open questions for the owner

- Which tax mode should be the default for a new Singapore store, and for a new Malaysian store?
- Is a Malaysian store's shelf price normally tax-inclusive or exclusive for your clients? (UNVERIFIED)
- Should service charge (F&B) be in scope? It is outside V1 today.

## Sources

- IRAS GST rate page and Record Keeping Guide (12th edition, 30 Jan 2026), as read by the research pass
- [Stripe: GST registration in Singapore](https://stripe.com/resources/more/gst-registration-in-singapore) (threshold, price display)
- [KPMG InvoiceNow alert](https://assets.kpmg.com/content/dam/kpmgsites/sg/pdf/2026/03/taxalert-202601-updated.pdf)
- [LHDN e-Invoice Specific Guideline](https://www.hasil.gov.my/wp-content/uploads/IRBM-e-Invoice-Specific-Guideline.pdf)
- Full notes: Practical Best POS Decision Brief (Claude Doc)
