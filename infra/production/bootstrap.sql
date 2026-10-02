\set ON_ERROR_STOP 1
-- Read only the mounted files; passwords never become command-line arguments.
\set migrator_password `cat /run/secrets/migrator_password`
\set runtime_password `cat /run/secrets/runtime_password`
BEGIN;
SELECT format('CREATE ROLE counter_pos_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'migrator_password') \gexec
SELECT format('CREATE ROLE counter_pos_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'runtime_password') \gexec
GRANT CONNECT, TEMPORARY ON DATABASE counter_pos TO counter_pos_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO counter_pos_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
COMMIT;
\unset migrator_password
\unset runtime_password
