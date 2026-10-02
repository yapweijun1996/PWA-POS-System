-- Counter POS: proposed PostgreSQL reference schema, version 1.0.
-- DESIGN CONTRACT ONLY. Not applied or production-certified.
-- Review migration target, application invariants, runtime privileges and restore plan before use.
-- Monetary values are minor units. API cap: 1,000,000,000; SQL BIGINT allows safe aggregation.
BEGIN;
CREATE TYPE pos_role AS ENUM ('CASHIER','MANAGER');
CREATE TYPE payment_method AS ENUM ('CASH','CARD_MANUAL','PAYNOW_MANUAL');
CREATE TYPE stock_movement_type AS ENUM ('RECEIPT','SALE','RETURN','ADJUSTMENT');
CREATE TYPE shift_state AS ENUM ('OPEN','CLOSED');
CREATE TYPE delivery_state AS ENUM ('PENDING','SENDING','ACKED','RETRY','NEEDS_REVIEW');

CREATE TABLE stores (
 id uuid PRIMARY KEY,
 name varchar(120) NOT NULL,
 currency char(3) NOT NULL CHECK (currency IN ('SGD','MYR')),
 timezone varchar(80) NOT NULL DEFAULT 'Asia/Singapore',
 tax_enabled boolean NOT NULL DEFAULT false,
 catalogue_version bigint NOT NULL DEFAULT 1 CHECK (catalogue_version > 0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id),
 email varchar(254) NOT NULL, display_name varchar(100) NOT NULL,
 password_hash text NOT NULL, role pos_role NOT NULL,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(store_id,id), UNIQUE(store_id,email)
);
CREATE TABLE devices (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id),
 name varchar(80) NOT NULL, enrolled_by uuid NOT NULL,
 enrolled_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 UNIQUE(store_id,id), UNIQUE(store_id,name),
 FOREIGN KEY(store_id,enrolled_by) REFERENCES users(store_id,id)
);
CREATE TABLE categories (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id),
 name varchar(80) NOT NULL, sort_order integer NOT NULL DEFAULT 0,
 active boolean NOT NULL DEFAULT true,
 UNIQUE(store_id,id), UNIQUE(store_id,name)
);
CREATE TABLE products (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), category_id uuid NOT NULL,
 sku varchar(64) NOT NULL CHECK (sku=upper(trim(sku)) AND length(sku)>0),
 barcode varchar(80) CHECK (barcode IS NULL OR (barcode=trim(barcode) AND length(barcode)>0)),
 name varchar(160) NOT NULL, cost_minor bigint NOT NULL DEFAULT 0 CHECK(cost_minor BETWEEN 0 AND 1000000000),
 low_stock_threshold integer NOT NULL DEFAULT 6 CHECK(low_stock_threshold>=0),
 image_key varchar(500), active boolean NOT NULL DEFAULT true,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(store_id,id), UNIQUE(store_id,sku), UNIQUE(store_id,barcode),
 FOREIGN KEY(store_id,category_id) REFERENCES categories(store_id,id)
);
CREATE INDEX products_category_active_idx ON products(store_id,category_id,active);
CREATE TABLE product_prices (
 id uuid PRIMARY KEY, store_id uuid NOT NULL, product_id uuid NOT NULL,
 catalogue_version bigint NOT NULL CHECK(catalogue_version>0),
 unit_price_minor bigint NOT NULL CHECK(unit_price_minor BETWEEN 0 AND 1000000000),
 tax_bps integer NOT NULL DEFAULT 0 CHECK(tax_bps BETWEEN 0 AND 10000),
 created_by uuid NOT NULL, valid_from timestamptz NOT NULL DEFAULT now(),
 UNIQUE(store_id,id), UNIQUE(store_id,product_id,id), UNIQUE(store_id,product_id,catalogue_version),
 FOREIGN KEY(store_id,product_id) REFERENCES products(store_id,id),
 FOREIGN KEY(store_id,created_by) REFERENCES users(store_id,id)
);
CREATE TABLE shifts (
 id uuid PRIMARY KEY, store_id uuid NOT NULL, device_id uuid NOT NULL, opened_by uuid NOT NULL,
 business_date date NOT NULL, state shift_state NOT NULL DEFAULT 'OPEN',
 opening_float_minor bigint NOT NULL CHECK(opening_float_minor BETWEEN 0 AND 1000000000),
 opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz, closed_by uuid,
 expected_cash_minor bigint, counted_cash_minor bigint CHECK(counted_cash_minor>=0),
 variance_minor bigint, variance_reason varchar(500), version bigint NOT NULL DEFAULT 1,
 UNIQUE(store_id,id), UNIQUE(store_id,id,device_id),
 FOREIGN KEY(store_id,device_id) REFERENCES devices(store_id,id),
 FOREIGN KEY(store_id,opened_by) REFERENCES users(store_id,id),
 FOREIGN KEY(store_id,closed_by) REFERENCES users(store_id,id),
 CHECK ((state='OPEN' AND closed_at IS NULL) OR (state='CLOSED' AND closed_at IS NOT NULL AND closed_by IS NOT NULL AND expected_cash_minor IS NOT NULL AND counted_cash_minor IS NOT NULL AND variance_minor IS NOT NULL)),
 CHECK (variance_minor IS NULL OR variance_minor = counted_cash_minor - expected_cash_minor),
 CHECK (variance_minor IS NULL OR variance_minor=0 OR (variance_reason IS NOT NULL AND length(trim(variance_reason))>0))
);
-- Proposed V1 allows one active selling shift per store, not only per device.
CREATE UNIQUE INDEX one_open_shift_per_store ON shifts(store_id) WHERE state='OPEN';
CREATE TABLE offline_permits (
 id uuid PRIMARY KEY, store_id uuid NOT NULL, shift_id uuid NOT NULL, device_id uuid NOT NULL, user_id uuid NOT NULL,
 issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL CHECK(expires_at>issued_at),
 max_sales integer NOT NULL DEFAULT 200 CHECK(max_sales>0),
 signed_claims jsonb NOT NULL, signature text NOT NULL, revoked_at timestamptz,
 UNIQUE(store_id,id),
 FOREIGN KEY(store_id,shift_id,device_id) REFERENCES shifts(store_id,id,device_id),
 FOREIGN KEY(store_id,user_id) REFERENCES users(store_id,id)
);
CREATE TABLE sales (
 id uuid PRIMARY KEY, store_id uuid NOT NULL, client_sale_id uuid NOT NULL,
 shift_id uuid NOT NULL, device_id uuid NOT NULL, cashier_id uuid NOT NULL, offline_permit_id uuid,
 receipt_seq bigint GENERATED ALWAYS AS IDENTITY,
 receipt_no varchar(80) NOT NULL, currency char(3) NOT NULL,
 gross_minor bigint NOT NULL CHECK(gross_minor BETWEEN 0 AND 1000000000),
 discount_minor bigint NOT NULL CHECK(discount_minor BETWEEN 0 AND gross_minor),
 tax_minor bigint NOT NULL CHECK(tax_minor BETWEEN 0 AND 1000000000),
 total_minor bigint NOT NULL CHECK(total_minor BETWEEN 0 AND 1000000000),
 payload_sha256 char(64) NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 schema_version integer NOT NULL CHECK(schema_version=1),
 was_offline boolean NOT NULL DEFAULT false,
 business_date date NOT NULL, client_created_at timestamptz NOT NULL, posted_at timestamptz NOT NULL DEFAULT now(),
 review_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
 UNIQUE(store_id,id), UNIQUE(store_id,client_sale_id), UNIQUE(store_id,receipt_no),
 FOREIGN KEY(store_id,shift_id,device_id) REFERENCES shifts(store_id,id,device_id),
 FOREIGN KEY(store_id,cashier_id) REFERENCES users(store_id,id),
 FOREIGN KEY(store_id,offline_permit_id) REFERENCES offline_permits(store_id,id),
 CHECK(total_minor=gross_minor-discount_minor+tax_minor),
 CHECK(NOT was_offline OR offline_permit_id IS NOT NULL)
);
CREATE INDEX sales_business_date_idx ON sales(store_id,business_date,posted_at,id);
CREATE INDEX sales_shift_idx ON sales(store_id,shift_id);
CREATE TABLE sale_lines (
 id uuid PRIMARY KEY, store_id uuid NOT NULL, sale_id uuid NOT NULL, product_id uuid NOT NULL, price_revision_id uuid NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 1 AND 100),
 sku_snapshot varchar(64) NOT NULL, name_snapshot varchar(160) NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 999),
 unit_price_minor bigint NOT NULL CHECK(unit_price_minor BETWEEN 0 AND 1000000000),
 discount_minor bigint NOT NULL DEFAULT 0 CHECK(discount_minor>=0 AND discount_minor<=quantity::bigint*unit_price_minor),
 tax_bps integer NOT NULL CHECK(tax_bps BETWEEN 0 AND 10000),
 tax_minor bigint NOT NULL CHECK(tax_minor BETWEEN 0 AND 1000000000),
 line_total_minor bigint NOT NULL CHECK(line_total_minor BETWEEN 0 AND 1000000000),
 UNIQUE(store_id,id), UNIQUE(store_id,sale_id,id), UNIQUE(store_id,sale_id,position),
 FOREIGN KEY(store_id,sale_id) REFERENCES sales(store_id,id),
 FOREIGN KEY(store_id,product_id,price_revision_id) REFERENCES product_prices(store_id,product_id,id),
 CHECK(line_total_minor=quantity::bigint*unit_price_minor-discount_minor+tax_minor),
 CHECK(tax_minor=((quantity::bigint*unit_price_minor-discount_minor)*tax_bps+5000)/10000)
);
CREATE TABLE payments (
 id uuid PRIMARY KEY, store_id uuid NOT NULL, sale_id uuid NOT NULL, method payment_method NOT NULL,
 amount_applied_minor bigint NOT NULL CHECK(amount_applied_minor BETWEEN 0 AND 1000000000),
 tender_minor bigint NOT NULL CHECK(tender_minor BETWEEN 0 AND 1000000000),
 change_minor bigint NOT NULL CHECK(change_minor BETWEEN 0 AND 1000000000),
 external_reference varchar(120), operator_verified_at timestamptz,
 recorded_by uuid NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(store_id,id), UNIQUE(store_id,sale_id),
 FOREIGN KEY(store_id,sale_id) REFERENCES sales(store_id,id),
 FOREIGN KEY(store_id,recorded_by) REFERENCES users(store_id,id),
 CHECK(tender_minor-change_minor=amount_applied_minor),
 CHECK((method='CASH' AND external_reference IS NULL) OR
       (method<>'CASH' AND change_minor=0 AND operator_verified_at IS NOT NULL AND external_reference IS NOT NULL AND length(trim(external_reference))>0))
);
CREATE TABLE refunds (
 id uuid PRIMARY KEY, store_id uuid NOT NULL, client_refund_id uuid NOT NULL,
 original_sale_id uuid NOT NULL, shift_id uuid NOT NULL, manager_id uuid NOT NULL,
 currency char(3) NOT NULL, total_minor bigint NOT NULL CHECK(total_minor BETWEEN 0 AND 1000000000),
 reason varchar(500) NOT NULL CHECK(length(trim(reason))>0),
 payload_sha256 char(64) NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
 business_date date NOT NULL, posted_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(store_id,id), UNIQUE(store_id,client_refund_id), UNIQUE(store_id,id,original_sale_id),
 FOREIGN KEY(store_id,original_sale_id) REFERENCES sales(store_id,id),
 FOREIGN KEY(store_id,shift_id) REFERENCES shifts(store_id,id),
 FOREIGN KEY(store_id,manager_id) REFERENCES users(store_id,id)
);
CREATE INDEX refunds_original_idx ON refunds(store_id,original_sale_id);
CREATE TABLE refund_lines (
 id uuid PRIMARY KEY, store_id uuid NOT NULL, refund_id uuid NOT NULL, original_sale_id uuid NOT NULL, original_sale_line_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 999), restock boolean NOT NULL,
 net_minor bigint NOT NULL CHECK(net_minor>=0), tax_minor bigint NOT NULL CHECK(tax_minor>=0), total_minor bigint NOT NULL CHECK(total_minor BETWEEN 0 AND 1000000000),
 UNIQUE(store_id,id), UNIQUE(store_id,refund_id,original_sale_line_id),
 FOREIGN KEY(store_id,refund_id,original_sale_id) REFERENCES refunds(store_id,id,original_sale_id),
 FOREIGN KEY(store_id,original_sale_id,original_sale_line_id) REFERENCES sale_lines(store_id,sale_id,id),
 CHECK(total_minor=net_minor+tax_minor)
);
CREATE INDEX refund_lines_original_idx ON refund_lines(store_id,original_sale_line_id);
CREATE TABLE refund_payments (
 id uuid PRIMARY KEY, store_id uuid NOT NULL, refund_id uuid NOT NULL,
 method payment_method NOT NULL, amount_minor bigint NOT NULL CHECK(amount_minor BETWEEN 0 AND 1000000000),
 external_reference varchar(120), operator_verified_at timestamptz,
 UNIQUE(store_id,id), UNIQUE(store_id,refund_id),
 FOREIGN KEY(store_id,refund_id) REFERENCES refunds(store_id,id),
 CHECK(method='CASH' OR (operator_verified_at IS NOT NULL AND external_reference IS NOT NULL AND length(trim(external_reference))>0))
);
CREATE TABLE stock_balances (
 store_id uuid NOT NULL, product_id uuid NOT NULL, quantity integer NOT NULL DEFAULT 0,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(store_id,product_id), FOREIGN KEY(store_id,product_id) REFERENCES products(store_id,id)
);
CREATE TABLE stock_movements (
 id uuid PRIMARY KEY, store_id uuid NOT NULL, product_id uuid NOT NULL, movement_type stock_movement_type NOT NULL,
 quantity_delta integer NOT NULL CHECK(quantity_delta<>0), sale_line_id uuid, refund_line_id uuid,
 admin_event_id uuid, reference varchar(120) NOT NULL, reason varchar(500), actor_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(store_id,id), UNIQUE(store_id,sale_line_id), UNIQUE(store_id,refund_line_id), UNIQUE(store_id,admin_event_id,product_id),
 FOREIGN KEY(store_id,product_id) REFERENCES products(store_id,id),
 FOREIGN KEY(store_id,sale_line_id) REFERENCES sale_lines(store_id,id),
 FOREIGN KEY(store_id,refund_line_id) REFERENCES refund_lines(store_id,id),
 FOREIGN KEY(store_id,actor_id) REFERENCES users(store_id,id),
 CHECK((movement_type='SALE' AND quantity_delta<0 AND sale_line_id IS NOT NULL AND refund_line_id IS NULL AND admin_event_id IS NULL)
    OR (movement_type='RETURN' AND quantity_delta>0 AND refund_line_id IS NOT NULL AND sale_line_id IS NULL AND admin_event_id IS NULL)
    OR (movement_type='RECEIPT' AND quantity_delta>0 AND admin_event_id IS NOT NULL AND sale_line_id IS NULL AND refund_line_id IS NULL AND reason IS NOT NULL AND length(trim(reason))>0)
    OR (movement_type='ADJUSTMENT' AND admin_event_id IS NOT NULL AND sale_line_id IS NULL AND refund_line_id IS NULL AND reason IS NOT NULL AND length(trim(reason))>0))
);
CREATE INDEX stock_movements_ledger_idx ON stock_movements(store_id,product_id,occurred_at,id);
CREATE TABLE cash_movements (
 id uuid PRIMARY KEY, store_id uuid NOT NULL, shift_id uuid NOT NULL, actor_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor<>0 AND amount_minor BETWEEN -1000000000 AND 1000000000),
 reason varchar(500) NOT NULL CHECK(length(trim(reason))>0), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(store_id,id), FOREIGN KEY(store_id,shift_id) REFERENCES shifts(store_id,id),
 FOREIGN KEY(store_id,actor_id) REFERENCES users(store_id,id)
);
CREATE TABLE audit_events (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), actor_id uuid, device_id uuid,
 action varchar(80) NOT NULL, subject_type varchar(80) NOT NULL, subject_id uuid NOT NULL,
 reason varchar(500), request_id varchar(100) NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 occurred_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(store_id,id), FOREIGN KEY(store_id,actor_id) REFERENCES users(store_id,id),
 FOREIGN KEY(store_id,device_id) REFERENCES devices(store_id,id)
);
CREATE INDEX audit_subject_idx ON audit_events(store_id,subject_type,subject_id,occurred_at);
CREATE TABLE sync_quarantine (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id), device_id uuid NOT NULL,
 client_document_id uuid NOT NULL, schema_version integer NOT NULL,
 payload jsonb NOT NULL, payload_sha256 char(64) NOT NULL,
 reason_code varchar(80) NOT NULL, resolved_by uuid, resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(store_id,client_document_id,payload_sha256),
 FOREIGN KEY(store_id,device_id) REFERENCES devices(store_id,id),
 FOREIGN KEY(store_id,resolved_by) REFERENCES users(store_id,id)
);
CREATE TABLE integration_outbox (
 id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id),
 event_type varchar(80) NOT NULL, schema_version integer NOT NULL DEFAULT 1,
 aggregate_id uuid NOT NULL, payload jsonb NOT NULL,
 state delivery_state NOT NULL DEFAULT 'PENDING', attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_retry_at timestamptz, last_error_code varchar(80), created_at timestamptz NOT NULL DEFAULT now(), acked_at timestamptz,
 UNIQUE(store_id,id)
);
CREATE INDEX integration_pending_idx ON integration_outbox(state,next_retry_at) WHERE state IN ('PENDING','RETRY');

-- Selected history is append-only; use a separate restricted migration/maintenance role.
CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Posted history is immutable: create a linked compensating event';
END;
$$;
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['product_prices','sales','sale_lines','payments','refunds','refund_lines','refund_payments','stock_movements','cash_movements','audit_events']
 LOOP
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_history_mutation()',t);
 END LOOP;
END;
$$;
COMMIT;

-- REQUIRED APPLICATION INVARIANTS (not proven by this DDL):
-- 1. Sale lines sum to sale total; applied payment equals sale total; max 100 lines.
-- 2. Currency/price revision and offline permit match store/user/device/shift and time limits.
-- 3. Lock balances then atomically insert SALE/RETURN and update projection exactly once.
-- 4. Movement product/quantity must match its referenced sale/refund line (service validation).
-- 5. Lock original sale lines; cumulative returned quantity/amount cannot exceed entitlement.
-- 6. Enforce online stock blocking before physical payment; authentic offline replay flags shortages.
-- 7. Final shift close needs zero pending/review documents and terminal reconciliation evidence.
-- 8. Runtime role must not own tables or bypass history guards; grants/RLS need security review.
-- 9. Normalize email consistently; protect session store separately; no seed credentials here.
