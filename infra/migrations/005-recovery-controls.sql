BEGIN;
ALTER TABLE stock_movements ADD COLUMN command_sha256 char(64);
ALTER TABLE sync_quarantine ADD COLUMN resolution_reason varchar(500);
ALTER TABLE sync_quarantine ADD COLUMN resolution_reference varchar(120);
ALTER TABLE terminal_reconciliations ADD COLUMN activity_sha256 char(64);
CREATE TABLE terminal_documents (
 store_id uuid NOT NULL, shift_id uuid NOT NULL, device_id uuid NOT NULL,
 client_sale_id uuid NOT NULL, payload_sha256 char(64) NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(store_id,client_sale_id),
 FOREIGN KEY(store_id,shift_id,device_id) REFERENCES shifts(store_id,id,device_id)
);
GRANT SELECT,INSERT ON terminal_documents TO counter_pos_app;
COMMIT;
