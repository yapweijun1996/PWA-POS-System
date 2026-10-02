BEGIN;
ALTER TABLE stores ADD COLUMN inventory_version bigint NOT NULL DEFAULT 1 CHECK(inventory_version>0);
-- Snapshot cursors must advance for stock postings as well as product edits.
CREATE FUNCTION advance_inventory_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE stores SET inventory_version=inventory_version+1 WHERE id=NEW.store_id;
 RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_revision AFTER INSERT OR UPDATE ON stock_balances
 FOR EACH ROW EXECUTE FUNCTION advance_inventory_revision();
COMMIT;
