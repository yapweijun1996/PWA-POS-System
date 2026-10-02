# Local development and synthetic demonstration

Prerequisites: Node 24.19.0 and PostgreSQL 16. Use `.nvmrc` with your Node version manager. The lockfile is required.

```sh
npm ci
npm run dev:db
npm run build
npm run demo
```

Open `http://localhost:3000`. Choose the synthetic manager or cashier demo. Each account is seeded with a random password stored only in ignored `.local/demo-users.json` with mode 0600. The local demo entry point grants a session only when demo mode is explicitly enabled for the isolated dev/test database. It is disabled in production. No fixed public administrator password exists.

`dev:db` uses a PostgreSQL installation at `/opt/homebrew/opt/postgresql@16/bin` by default. On another host, set `PG_BIN` to the directory containing `initdb`, `pg_ctl`, `psql` and `createdb`. It creates an ignored cluster bound to 127.0.0.1:55432 with isolated `counter_pos_dev` and `counter_pos_test` databases. This local-only cluster uses trust authentication; do not expose it to a network. An optional password-protected development Docker definition is in `infra/compose.yaml`. When using password authentication, run migrations with the owner URL, then set a separate runtime-role password privately (for example with psql's interactive `\password counter_pos_app`). Supply the owner URL as `DATABASE_URL` and the runtime URL as `RUNTIME_DATABASE_URL` to the demo/dev launchers. The runtime username is always forced to `counter_pos_app`. The CI fixture sets a public test-only runtime password before its tests; no production password is stored in migrations.

`npm run dev` starts Vite and the API for code editing. The service worker is disabled under Vite development mode. Use the built `npm run demo` application for offline/install/update verification.

## Demonstrate the day

1. Enter the manager demo and open a shift with 100.00 float.
2. Add two Cold Brew, one Oat Cookies and one Sparkling Water. Take 20.00 cash for the 14.00 basket; observe 6.00 change and the synced receipt.
3. Open Inventory to see negative SALE movements and Products to edit metadata/pricing separately from stock.
4. Disconnect after readiness. Cash remains available inside the current permit. A saved local receipt has a pending label. Reload preserves it; new offline selling after restart requires reconnection to establish trusted time.
5. Reconnect and open Sync center. Reauthentication uses the original operator and retries the preserved UUID. Do not clear browser data.
6. View Sales, open a posted receipt and return eligible quantities. Select damaged/restockable explicitly.
7. Count the drawer and close the shift after every document syncs and negative stock/quarantine cases are reconciled.

Synthetic demo state is persistent. Refreshing does not reset it. The test launchers reset only `counter_pos_test` on loopback and refuse other targets; they do not reset development or shop databases. To stop the task-created development cluster: `npx tsx scripts/database.ts stop`.

## Verify

```sh
npm run build
npm run format:check
npm run security:check
npm test
npm run test:integration
npx playwright install chromium
npm run test:e2e
npm run backup:rehearse
npm audit --audit-level=moderate
```

Integration, E2E and restore commands must run sequentially because they share the isolated test database. Override `TEST_DATABASE_URL` for CI; its name must remain exactly `counter_pos_test` and the host loopback. Only these launchers are allowed to reset that fixture schema. `PG_BIN` makes the database/restore scripts portable. CI is provided but its remote execution is not implied by local success.

Initial non-demo setup uses reviewed migrations, then `npx tsx scripts/setup.ts` with `DATABASE_URL`, `SETUP_EMAIL` and `SETUP_PASSWORD` supplied through private environment injection. It refuses a deployment that already has a store. Enroll the one named terminal with the manager device endpoint. Store currency stays fixed; this release provides no tax/currency change endpoint.
