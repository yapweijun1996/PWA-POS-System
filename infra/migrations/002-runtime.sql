BEGIN;
ALTER TABLE product_prices ADD COLUMN name_snapshot varchar(160) NOT NULL DEFAULT '';
ALTER TABLE product_prices ADD COLUMN sku_snapshot varchar(64) NOT NULL DEFAULT '';
CREATE TABLE sessions (
 id_hash char(64) PRIMARY KEY, store_id uuid NOT NULL, user_id uuid NOT NULL,
 csrf_token char(64) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 FOREIGN KEY(store_id,user_id) REFERENCES users(store_id,id)
);
ALTER TABLE devices ADD COLUMN selling boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX one_selling_device ON devices(store_id) WHERE selling AND revoked_at IS NULL;
CREATE TABLE terminal_reconciliations (
 id uuid PRIMARY KEY, store_id uuid NOT NULL, shift_id uuid NOT NULL, device_id uuid NOT NULL,
 sale_ids jsonb NOT NULL, acknowledged_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(store_id,shift_id,device_id) REFERENCES shifts(store_id,id,device_id)
);
CREATE TABLE shift_counts (
 store_id uuid NOT NULL, shift_id uuid NOT NULL, counted_minor bigint NOT NULL CHECK(counted_minor BETWEEN 0 AND 1000000000),
 reason varchar(500), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(store_id,shift_id), FOREIGN KEY(store_id,shift_id) REFERENCES shifts(store_id,id)
);
COMMIT;
