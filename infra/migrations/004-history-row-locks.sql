BEGIN;
-- PostgreSQL requires UPDATE on at least one column for SELECT FOR UPDATE.
-- Only identity columns are granted; immutable_history rejects every actual UPDATE.
GRANT UPDATE(id) ON sales,sale_lines TO counter_pos_app;
COMMIT;
