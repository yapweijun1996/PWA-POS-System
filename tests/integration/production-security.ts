import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { createApp } from "../../apps/api/src/app.ts";
import { sessionDigest } from "../../apps/api/src/auth.ts";
import { databaseReady } from "../../apps/api/src/readiness.ts";
import { database } from "../../apps/api/src/db.ts";

type Headers = Record<string, string>;
export async function runProductionSecurity({
  app,
  pool,
  managerHeaders,
  cashierHeaders,
  check,
}: {
  app: FastifyInstance;
  pool: pg.Pool;
  managerHeaders: Headers;
  cashierHeaders: Headers;
  check: (name: string, task: () => Promise<void>) => Promise<void>;
}) {
  const suffix = randomUUID(),
    password = "Synthetic-user-password-2026",
    nextPassword = "Synthetic-new-password-2026";
  let user: { id: string; email: string; version: number };
  async function request(
    path: string,
    body?: unknown,
    headers = managerHeaders,
    method = body === undefined ? "GET" : "POST",
  ) {
    return app.inject({
      method: method as "GET" | "POST" | "PATCH",
      url: "/api/v1" + path,
      headers: { ...headers, "content-type": "application/json" },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  await check(
    "Production operators: cashier denied, normalized identities and credential projections",
    async () => {
      assert.equal(
        (await request("/users", undefined, cashierHeaders)).statusCode,
        403,
      );
      assert.equal(
        (
          await request("/users", {
            email: "valid@example.test",
            display_name: "Short password",
            role: "CASHIER",
            password: "short",
          })
        ).statusCode,
        422,
      );
      const response = await request("/users", {
        email: ` Operator-${suffix}@Example.Test `,
        display_name: "Security test operator",
        role: "CASHIER",
        password,
      });
      assert.equal(response.statusCode, 201, response.body);
      user = response.json();
      assert.equal(user.email, `operator-${suffix}@example.test`);
      assert.equal(user.version, 1);
      const list = await request("/users");
      assert.equal(list.statusCode, 200, list.body);
      assert.ok(
        !list.body.includes("password_hash") &&
          !list.body.includes("security_version") &&
          !list.body.includes(password),
      );
      assert.equal(
        (
          await request("/users", {
            email: user.email.toUpperCase(),
            display_name: "Duplicate",
            role: "CASHIER",
            password,
          })
        ).statusCode,
        409,
      );
    },
  );
  const runtimeUrl = pool.options.connectionString;
  assert.ok(runtimeUrl);
  const secureConfig = {
    databaseUrl: runtimeUrl,
    origin: "https://pos.example.test",
    secret: "production-test-key-unique-to-this-isolated-fixture",
    demo: false,
    test: true,
    production: true,
  };
  const { app: secureApp } = await createApp(secureConfig);
  const secureOrigin = "https://pos.example.test";
  const sessionHeaders = (
    response: Awaited<ReturnType<typeof secureApp.inject>>,
  ): Headers => ({
    origin: secureOrigin,
    cookie: response.cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; "),
    "x-csrf-token": response.json().csrf_token,
  });
  let logins = 0;
  async function login(pass = password) {
    // Keep login rate limiting active while giving independent clients unique test addresses.
    return secureApp.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { origin: secureOrigin },
      payload: { email: user.email, password: pass },
      remoteAddress: `127.0.0.${++logins}`,
    });
  }
  const secureRequest = (path: string, body: unknown, headers: Headers) =>
    secureApp.inject({
      method: body === undefined ? "GET" : "POST",
      url: "/api/v1" + path,
      headers: { ...headers, "content-type": "application/json" },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
  let currentHeaders: Headers, secondHeaders: Headers;
  try {
    await check(
      "Production auth: secure cookies, disabled demo, origin/CSRF enforcement and keyed storage",
      async () => {
        assert.equal(
          (
            await secureApp.inject({
              method: "POST",
              url: "/api/v1/demo/login",
              headers: { origin: secureOrigin },
              payload: { role: "MANAGER" },
            })
          ).statusCode,
          404,
        );
        const response = await login();
        assert.equal(response.statusCode, 200, response.body);
        assert.match(String(response.headers["set-cookie"]), /HttpOnly/);
        assert.match(String(response.headers["set-cookie"]), /Secure/);
        assert.match(String(response.headers["set-cookie"]), /SameSite=Strict/);
        assert.equal(response.headers["cache-control"], "no-store");
        assert.equal(
          response.headers["strict-transport-security"],
          "max-age=31536000",
        );
        currentHeaders = sessionHeaders(response);
        secondHeaders = sessionHeaders(await login());
        assert.equal(
          (await secureRequest("/bootstrap", undefined, currentHeaders))
            .statusCode,
          200,
        );
        assert.equal(
          (
            await secureRequest(
              "/auth/logout",
              {},
              { ...currentHeaders, origin: "https://attacker.example.test" },
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await secureRequest(
              "/auth/logout",
              {},
              { ...currentHeaders, "x-csrf-token": "invalid" },
            )
          ).statusCode,
          403,
        );
        const token = response.cookies[0].value;
        const stored = (
          await pool.query("SELECT id_hash FROM sessions WHERE user_id=$1", [
            user.id,
          ])
        ).rows.map((row) => row.id_hash);
        assert.ok(!stored.includes(token));
        assert.ok(
          !stored.includes(createHash("sha256").update(token).digest("hex")),
        );
        const storedUser = (
          await pool.query("SELECT password_hash FROM users WHERE id=$1", [
            user.id,
          ])
        ).rows[0];
        assert.match(storedUser.password_hash, /^scrypt\$32768\$8\$1\$/);
        assert.ok(!storedUser.password_hash.includes(password));
        await databaseReady(pool, true);
        const ownerUrl = new URL(runtimeUrl);
        ownerUrl.username = "counter_pos_owner";
        const privileged = database(ownerUrl.toString());
        try {
          await assert.rejects(
            () => databaseReady(privileged, true),
            /Production database role is not restricted/,
          );
        } finally {
          await privileged.end();
        }
      },
    );
    await check(
      "Production session policy: inactivity, absolute expiry, logout and login rate limits",
      async () => {
        const inactive = await login();
        await pool.query(
          "UPDATE sessions SET last_seen_at=now()-interval '31 minutes' WHERE id_hash=$1",
          [sessionDigest(inactive.cookies[0].value, secureConfig)],
        );
        assert.equal(
          (
            await secureRequest(
              "/bootstrap",
              undefined,
              sessionHeaders(inactive),
            )
          ).statusCode,
          401,
        );
        const expired = await login();
        await pool.query(
          "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id_hash=$1",
          [sessionDigest(expired.cookies[0].value, secureConfig)],
        );
        assert.equal(
          (
            await secureRequest(
              "/bootstrap",
              undefined,
              sessionHeaders(expired),
            )
          ).statusCode,
          401,
        );
        const logout = sessionHeaders(await login());
        assert.equal(
          (await secureRequest("/auth/logout", {}, logout)).statusCode,
          204,
        );
        assert.equal(
          (await secureRequest("/bootstrap", undefined, logout)).statusCode,
          401,
        );
        const limited = [];
        for (let attempt = 0; attempt < 11; attempt++)
          limited.push(
            (
              await secureApp.inject({
                method: "POST",
                url: "/api/v1/auth/login",
                remoteAddress: "192.0.2.99",
                headers: { origin: secureOrigin },
                payload: { email: user.email, password: "incorrect-password" },
              })
            ).statusCode,
          );
        assert.deepEqual(limited, [...Array<number>(10).fill(401), 429]);
      },
    );
    await check(
      "Password lifecycle: old sessions revoked, replacement valid, concurrent changes cannot both succeed",
      async () => {
        const wrong = await secureRequest(
          "/auth/password",
          { current_password: "incorrect", new_password: nextPassword },
          currentHeaders,
        );
        assert.equal(wrong.statusCode, 401);
        assert.equal(
          (await secureRequest("/bootstrap", undefined, currentHeaders))
            .statusCode,
          200,
        );
        const changed = await secureRequest(
          "/auth/password",
          { current_password: password, new_password: nextPassword },
          currentHeaders,
        );
        assert.equal(changed.statusCode, 200, changed.body);
        assert.equal(
          (await secureRequest("/bootstrap", undefined, currentHeaders))
            .statusCode,
          401,
        );
        assert.equal(
          (await secureRequest("/bootstrap", undefined, secondHeaders))
            .statusCode,
          401,
        );
        currentHeaders = sessionHeaders(changed);
        assert.equal(
          (await secureRequest("/bootstrap", undefined, currentHeaders))
            .statusCode,
          200,
        );
        assert.equal((await login(password)).statusCode, 401);
        secondHeaders = sessionHeaders(await login(nextPassword));
        const attempts = await Promise.all([
          secureRequest(
            "/auth/password",
            {
              current_password: nextPassword,
              new_password: "Synthetic-race-password-one",
            },
            currentHeaders,
          ),
          secureRequest(
            "/auth/password",
            {
              current_password: nextPassword,
              new_password: "Synthetic-race-password-two",
            },
            secondHeaders,
          ),
        ]);
        assert.deepEqual(
          attempts.map((response) => response.statusCode).sort(),
          [200, 401],
        );
        currentHeaders = sessionHeaders(
          attempts.find((response) => response.statusCode === 200)!,
        );
        assert.equal(
          (await secureRequest("/bootstrap", undefined, currentHeaders))
            .statusCode,
          200,
        );
        const winnerPassword =
          attempts[0].statusCode === 200
            ? "Synthetic-race-password-one"
            : "Synthetic-race-password-two";
        secondHeaders = sessionHeaders(await login(winnerPassword));
        const revoked = await secureRequest(
          "/auth/revoke-sessions",
          { current_password: winnerPassword },
          currentHeaders,
        );
        assert.equal(revoked.statusCode, 200, revoked.body);
        assert.equal(
          (await secureRequest("/bootstrap", undefined, currentHeaders))
            .statusCode,
          401,
        );
        assert.equal(
          (await secureRequest("/bootstrap", undefined, secondHeaders))
            .statusCode,
          401,
        );
        currentHeaders = sessionHeaders(revoked);
        assert.equal(
          (await secureRequest("/bootstrap", undefined, currentHeaders))
            .statusCode,
          200,
        );
        const audit = (
          await pool.query(
            "SELECT action,reason FROM audit_events WHERE subject_id=$1",
            [user.id],
          )
        ).rows;
        assert.ok(
          audit.some((event) => event.action === "USER_PASSWORD_CHANGED"),
        );
        assert.ok(!JSON.stringify(audit).includes(password));
      },
    );
    await check(
      "Manager reset/deactivation: stale versions rejected and old sessions cannot regain access",
      async () => {
        user = (await request("/users"))
          .json()
          .find((entry: { id: string }) => entry.id === user.id);
        const reset = await request(`/users/${user.id}/password`, {
          version: user.version,
          new_password: "Synthetic-manager-reset-password",
          reason: "Fixture operator recovery",
        });
        assert.equal(reset.statusCode, 200, reset.body);
        assert.equal(
          (await secureRequest("/bootstrap", undefined, currentHeaders))
            .statusCode,
          401,
        );
        assert.equal(
          (
            await request(`/users/${user.id}/password`, {
              version: user.version,
              new_password: "Synthetic-other-reset-password",
              reason: "Stale fixture attempt",
            })
          ).statusCode,
          409,
        );
        user = reset.json();
        currentHeaders = sessionHeaders(
          await login("Synthetic-manager-reset-password"),
        );
        const disabled = await request(
          `/users/${user.id}`,
          {
            version: user.version,
            active: false,
            reason: "Fixture operator disabled",
          },
          managerHeaders,
          "PATCH",
        );
        assert.equal(disabled.statusCode, 200, disabled.body);
        assert.equal(
          (await secureRequest("/bootstrap", undefined, currentHeaders))
            .statusCode,
          401,
        );
        assert.equal(
          (await login("Synthetic-manager-reset-password")).statusCode,
          401,
        );
        const manager = (await request("/users"))
          .json()
          .find(
            (entry: { role: string; active: boolean }) =>
              entry.role === "MANAGER" && entry.active,
          );
        assert.equal(
          (
            await request(
              `/users/${manager.id}`,
              {
                version: manager.version,
                active: false,
                reason: "Prevent manager lockout",
              },
              managerHeaders,
              "PATCH",
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await request(
              `/users/${randomUUID()}`,
              { version: 1, active: false, reason: "Foreign account" },
              managerHeaders,
              "PATCH",
            )
          ).statusCode,
          404,
        );
      },
    );
    await check(
      "Concurrent operator permission changes revalidate the manager after acquiring the store lock",
      async () => {
        const managers: {
          account: { id: string; email: string; version: number };
          headers: Headers;
        }[] = [];
        for (let index = 0; index < 2; index++) {
          const created = await request("/users", {
            email: `concurrent-${index}-${suffix}@example.test`,
            display_name: `Concurrent manager ${index}`,
            role: "MANAGER",
            password,
          });
          assert.equal(created.statusCode, 201, created.body);
          const account = created.json() as {
            id: string;
            email: string;
            version: number;
          };
          const response = await secureApp.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            remoteAddress: `198.51.100.${index + 1}`,
            headers: { origin: secureOrigin },
            payload: { email: account.email, password },
          });
          assert.equal(response.statusCode, 200, response.body);
          managers.push({ account, headers: sessionHeaders(response) });
        }
        const changes = await Promise.all(
          managers.map((actor, index) => {
            const target = managers[1 - index].account;
            return secureApp.inject({
              method: "PATCH",
              url: `/api/v1/users/${target.id}`,
              headers: { ...actor.headers, "content-type": "application/json" },
              payload: JSON.stringify({
                version: target.version,
                role: "CASHIER",
                reason: "Concurrent permission fixture",
              }),
            });
          }),
        );
        assert.deepEqual(
          changes.map((response) => response.statusCode).sort(),
          [200, 401],
        );
        const users = (await request("/users")).json() as {
          id: string;
          version: number;
        }[];
        for (const candidate of managers) {
          const target = users.find(
            (entry) => entry.id === candidate.account.id,
          )!;
          const disabled = await request(
            `/users/${target.id}`,
            {
              version: target.version,
              active: false,
              reason: "Close concurrency fixture",
            },
            managerHeaders,
            "PATCH",
          );
          assert.equal(disabled.statusCode, 200, disabled.body);
        }
      },
    );
  } finally {
    await secureApp.close();
  }
}
