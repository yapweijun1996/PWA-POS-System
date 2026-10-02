# Synthetic fixture rules

All products and IDs are synthetic. Example prices use minor units; tax is disabled. Opening balances must be created through opening RECEIPT movements, not product quantity edits. The CSV is seed input, not an import implemented in the UI study. Stock sums to 198 units.

The canonical example-sale basket totals 1,400 minor units; cash tender is 2,000 and change 600. UUIDs are deterministic only for reproducible fixtures; real terminal sales generate and persist distinct IDs once.

The daily dashboard fixture is illustrative and separate from the single-sale payload: gross 48,600, refunds 1,800, net 46,800 minor units; 36 orders; average gross ticket 1,350. Shift cash applied is 28,600; opening float 10,000; cash refund 1,800; cash out 2,000; expected cash 34,800.
