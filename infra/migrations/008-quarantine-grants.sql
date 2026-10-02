BEGIN;
-- Rejected receipt evidence is immutable to the runtime role; managers append resolution metadata.
REVOKE UPDATE ON sync_quarantine FROM counter_pos_app;
GRANT UPDATE(resolved_at,resolved_by,resolution_reason,resolution_reference) ON sync_quarantine TO counter_pos_app;
COMMIT;
