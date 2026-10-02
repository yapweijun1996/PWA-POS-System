BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='counter_pos_app') THEN
  CREATE ROLE counter_pos_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
 END IF;
END $$;
GRANT USAGE ON SCHEMA public TO counter_pos_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO counter_pos_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO counter_pos_app;
GRANT INSERT ON products,product_prices,stock_balances,stock_movements,categories,devices,shifts,offline_permits,sales,sale_lines,payments,refunds,refund_lines,refund_payments,audit_events,integration_outbox,sync_quarantine,terminal_reconciliations,shift_counts,cash_movements,sessions TO counter_pos_app;
GRANT UPDATE ON products,stock_balances,stores,categories,devices,shifts,offline_permits,sync_quarantine,shift_counts,sessions TO counter_pos_app;
GRANT DELETE ON sessions TO counter_pos_app;
COMMIT;
