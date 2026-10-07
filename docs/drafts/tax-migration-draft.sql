-- TRIAL RESULT (2026-10-07, scratch DB on throwaway Postgres, not production):
--  * UP section applies cleanly; legacy backfill gave LEGACY/exclusive for taxed lines and
--    LEGACY/off for untaxed lines; refund_lines snapshots copied; breakdown UPDATE/DELETE blocked.
--  * BLOCKER FOUND: sale_lines (001-core.sql) has exclusive-only CHECKs:
--      line_total = qty*price - discount + tax  and  tax = ((qty*price-discount)*tax_bps+5000)/10000.
--    An inclusive line (1000 cents @ 9%: tax 83, total 1000) is REJECTED (sale_lines_check1).
--    sales has the same shape: total = gross - discount + tax. Inclusive mode needs these CHECKs
--    replaced by mode-aware ones (and sales.tax_mode) before it can be stored. Not yet drafted.
--  * Legacy sales have no sale_tax_breakdown rows; backfill is not drafted.
--  * Rollback section not executed.
-- DRAFT ONLY — additive tax schema proposal; not an executable/approved migration.
-- Basis: tax-mode spec, reference schema, migrations 001-008 and current sales/refunds writers.
-- No migration has been run. Review constraints, grants, and application deployment ordering.
BEGIN;

-- Explicit 'off' is the backwards-compatible store behavior. 'Tax' is a neutral
-- configurable label; jurisdiction-specific defaults remain an owner decision.
ALTER TABLE stores
  ADD COLUMN tax_mode varchar(10) NOT NULL DEFAULT 'off'
    CHECK (tax_mode IN ('off','exclusive','inclusive')),
  ADD COLUMN default_tax_label varchar(80) NOT NULL DEFAULT 'Tax';

-- Codes are tenant-scoped; composite uniqueness matches repository store scoping.
CREATE TABLE tax_codes (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(id),
  code varchar(32) NOT NULL CHECK (code=upper(trim(code)) AND length(code)>0),
  label varchar(80) NOT NULL CHECK (length(trim(label))>0),
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(store_id,id),
  UNIQUE(store_id,code)
);

-- nullable snapshots allow unknown legacy identity/mode; amounts are recoverable
-- from immutable posted line values, and no posted totals are recalculated.
ALTER TABLE sale_lines
  ADD COLUMN tax_code varchar(32),
  ADD COLUMN tax_label varchar(80),
  ADD COLUMN tax_mode varchar(10) CHECK (tax_mode IS NULL OR tax_mode IN ('off','exclusive','inclusive')),
  ADD COLUMN net_minor bigint CHECK (net_minor IS NULL OR net_minor BETWEEN 0 AND 1000000000);

-- The current API/domain calculation is exclusively tax_bps over
-- quantity*unit_price-discount with half-up integer rounding (money.ts lineMoney),
-- and stored line totals are base + tax. Thus nonzero-tax legacy rows can be
-- classified as exclusive based on available calculation code; semantics beyond
-- this representation remain UNVERIFIED. Zero-tax rows are labeled off per request.
UPDATE sale_lines
 SET net_minor = quantity::bigint * unit_price_minor - discount_minor,
     tax_code = 'LEGACY',
     tax_mode = CASE WHEN tax_bps = 0 THEN 'off' ELSE 'exclusive' END;
-- Legacy label is deliberately NULL: there is no historical label to snapshot.

-- One aggregate snapshot per sale and code. Composite FK binds to the sale's store.
CREATE TABLE sale_tax_breakdown (
  id uuid PRIMARY KEY,
  store_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  tax_code varchar(32) NOT NULL,
  label_snapshot varchar(80) NOT NULL,
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  net_minor bigint NOT NULL CHECK (net_minor BETWEEN 0 AND 1000000000),
  tax_minor bigint NOT NULL CHECK (tax_minor BETWEEN 0 AND 1000000000),
  UNIQUE(store_id,sale_id,tax_code),
  FOREIGN KEY(store_id,sale_id) REFERENCES sales(store_id,id)
);
-- Same append-only trigger function/mechanism established in 001-core.sql.
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON sale_tax_breakdown
 FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

-- Preserve original line tax identity on each refund posting; copied by the API
-- from the original immutable sale line, not inferred from current store settings.
ALTER TABLE refund_lines
  ADD COLUMN tax_code varchar(32),
  ADD COLUMN tax_label varchar(80),
  ADD COLUMN tax_mode varchar(10) CHECK (tax_mode IS NULL OR tax_mode IN ('off','exclusive','inclusive'));

-- Backfill refund snapshots from source sale lines; nullable labels remain unknown.
UPDATE refund_lines r
 SET tax_code = s.tax_code, tax_label = s.tax_label, tax_mode = s.tax_mode
 FROM sale_lines s
 WHERE s.store_id=r.store_id AND s.sale_id=r.original_sale_id
   AND s.id=r.original_sale_line_id;

-- Runtime access is UNVERIFIED: migration 002 grants are explicit and therefore
-- must be extended for tax_codes/sale_tax_breakdown and appropriate UPDATE on stores.
-- Runtime must receive SELECT/INSERT on tax_codes and SELECT/INSERT on breakdown;
-- breakdown UPDATE/DELETE must remain unavailable. Verify deployment role ownership.

COMMIT;

-- ROLLBACK (COMMENTED; destructive to newly stored snapshots; only safe before use):
-- BEGIN;
-- DROP TRIGGER immutable_history ON sale_tax_breakdown;
-- DROP TABLE sale_tax_breakdown;
-- ALTER TABLE refund_lines DROP COLUMN tax_code, DROP COLUMN tax_label, DROP COLUMN tax_mode;
-- ALTER TABLE sale_lines DROP COLUMN tax_code, DROP COLUMN tax_label, DROP COLUMN tax_mode, DROP COLUMN net_minor;
-- DROP TABLE tax_codes;
-- ALTER TABLE stores DROP COLUMN tax_mode, DROP COLUMN default_tax_label;
-- COMMIT;

-- Queries/tests found or implicated and requiring review/update:
-- * apps/api/src/sales.ts: INSERT sales and INSERT sale_lines must supply snapshots/net;
--   sale posting must aggregate and INSERT sale_tax_breakdown rows.
-- * apps/api/src/refunds.ts: sale_lines locking SELECT can retain SELECT *; refund_lines
--   INSERT must copy original tax snapshots. Add test coverage for this preservation.
-- * apps/api/src/app.ts: sale detail sale_lines query and refund detail refund_lines query
--   currently SELECT *; verify response/serialization contracts and receipt needs.
-- * apps/api/src/readiness.ts: no_history_delete relation list omits the new breakdown;
--   add sale_tax_breakdown (and tax_codes policy as decided).
-- * infra/migrations/002-runtime.sql: explicit grants need updates for new relations
--   and stores.tax_mode/default_tax_label update privileges.
-- * tests/integration/transactions.ts: posting/refund flows and reconciliation queries
--   use old line/refund shapes; update schema fixtures and assert snapshots/breakdown.
-- * tests/unit/money.test.ts and tests/unit/tax.test.ts: no database query changes,
--   but tax-mode and legacy migration behaviors need new tests. Other DB tests UNVERIFIED.
-- * apps/api/src/sales.ts still validates old money.ts exclusively; inclusive mode and
--   configurable codes need corresponding domain/contracts/API changes before deployment.
-- * Existing SQL consumers outside apps/api/tests and receipt rendering consumers are
--   UNVERIFIED. Specs schema intentionally not changed; regenerate only by separate review.
