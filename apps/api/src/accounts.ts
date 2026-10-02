import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { Config } from "./config.ts";
import { audit, manager } from "./context.ts";
import { issueSession } from "./auth.ts";
import { hashPassword, passwordMatches } from "./passwords.ts";
import { requireThat, transaction } from "./db.ts";

const password = z.string().min(12).max(200),
  reason = z.string().trim().min(1).max(500),
  version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  identity = z.string().uuid();
export const createUserCommand = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((s) => s.toLowerCase()),
    display_name: z.string().trim().min(1).max(100),
    role: z.enum(["MANAGER", "CASHIER"]),
    password,
  })
  .strict();
export const updateUserCommand = z
  .object({
    version,
    display_name: z.string().trim().min(1).max(100).optional(),
    role: z.enum(["MANAGER", "CASHIER"]).optional(),
    active: z.boolean().optional(),
    reason,
  })
  .strict()
  .refine(
    (v) =>
      v.display_name !== undefined ||
      v.role !== undefined ||
      v.active !== undefined,
  );
export const resetPasswordCommand = z
  .object({ version, new_password: password, reason })
  .strict();
export const changePasswordCommand = z
  .object({
    current_password: z.string().min(1).max(200),
    new_password: password,
  })
  .strict();
export const revokeSessionsCommand = z
  .object({ current_password: z.string().min(1).max(200) })
  .strict();
const projection =
  "id,email,display_name,role,active,security_version,created_at";
function visible(user: Record<string, unknown>) {
  const { security_version, ...fields } = user;
  return { ...fields, version: Number(security_version) };
}
async function authorizeManager(db: pg.PoolClient, req: FastifyRequest) {
  manager(req.context);
  // Serialize operator changes so concurrent demotions cannot remove every manager.
  await db.query("SELECT id FROM stores WHERE id=$1 FOR UPDATE", [
    req.context.actor.store_id,
  ]);
  const actor = (
    await db.query(
      "SELECT id FROM users WHERE store_id=$1 AND id=$2 AND active AND role='MANAGER' AND security_version=$3 FOR UPDATE",
      [req.context.actor.store_id, req.context.actor.id, req.securityVersion],
    )
  ).rows[0];
  requireThat(actor, "AUTH_REQUIRED", 401);
}
async function revoke(db: pg.PoolClient, store: string, user: string) {
  await db.query("DELETE FROM sessions WHERE store_id=$1 AND user_id=$2", [
    store,
    user,
  ]);
}
export async function accounts(
  app: FastifyInstance,
  pool: pg.Pool,
  config: Config,
) {
  app.get("/api/v1/users", async (req) => {
    manager(req.context);
    const rows = (
      await pool.query(
        `SELECT ${projection} FROM users WHERE store_id=$1 ORDER BY display_name,id`,
        [req.context.actor.store_id],
      )
    ).rows;
    return rows.map(visible);
  });
  app.post("/api/v1/users", async (req, reply) => {
    manager(req.context);
    const input = createUserCommand.parse(req.body);
    const hash = await hashPassword(input.password),
      id = randomUUID();
    const user = await transaction(pool, async (db) => {
      await authorizeManager(db, req);
      // Sign-in has a single email namespace for the one-store deployment contract.
      requireThat(
        !(
          await db.query("SELECT id FROM users WHERE lower(email)=$1", [
            input.email,
          ])
        ).rowCount,
        "VERSION_CONFLICT",
        409,
        "Account identity already exists",
      );
      const row = (
        await db.query(
          `INSERT INTO users(id,store_id,email,display_name,role,password_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${projection}`,
          [
            id,
            req.context.actor.store_id,
            input.email,
            input.display_name,
            input.role,
            hash,
          ],
        )
      ).rows[0];
      await audit(db, req.context, "USER_CREATED", "user", id);
      return visible(row);
    });
    return reply.code(201).send(user);
  });
  app.patch("/api/v1/users/:id", async (req) => {
    manager(req.context);
    const id = identity.parse((req.params as { id: string }).id),
      input = updateUserCommand.parse(req.body);
    return transaction(pool, async (db) => {
      await authorizeManager(db, req);
      const target = (
        await db.query(
          "SELECT * FROM users WHERE store_id=$1 AND id=$2 FOR UPDATE",
          [req.context.actor.store_id, id],
        )
      ).rows[0];
      requireThat(target, "NOT_FOUND", 404);
      requireThat(
        Number(target.security_version) === input.version,
        "VERSION_CONFLICT",
        409,
      );
      const role = input.role ?? target.role,
        active = input.active ?? target.active;
      const securityChange = role !== target.role || active !== target.active;
      if (securityChange) {
        requireThat(
          id !== req.context.actor.id,
          "FORBIDDEN",
          403,
          "Another manager must change your access",
        );
        if (
          target.active &&
          target.role === "MANAGER" &&
          (!active || role !== "MANAGER")
        ) {
          const remaining = (
            await db.query(
              "SELECT id FROM users WHERE store_id=$1 AND active AND role='MANAGER' AND id<>$2",
              [req.context.actor.store_id, id],
            )
          ).rowCount;
          requireThat(
            remaining,
            "LAST_MANAGER",
            409,
            "At least one active manager is required",
          );
        }
        requireThat(
          !(
            await db.query(
              "SELECT id FROM shifts WHERE store_id=$1 AND opened_by=$2 AND state='OPEN'",
              [req.context.actor.store_id, id],
            )
          ).rowCount,
          "USER_HAS_OPEN_SHIFT",
          409,
          "Reconcile and close this operator's shift before changing access",
        );
      }
      const row = (
        await db.query(
          `UPDATE users SET display_name=$3,role=$4,active=$5,security_version=security_version+1 WHERE store_id=$1 AND id=$2 RETURNING ${projection}`,
          [
            req.context.actor.store_id,
            id,
            input.display_name ?? target.display_name,
            role,
            active,
          ],
        )
      ).rows[0];
      await revoke(db, req.context.actor.store_id, id);
      if (!active)
        await db.query(
          "UPDATE offline_permits SET revoked_at=now() WHERE store_id=$1 AND user_id=$2 AND revoked_at IS NULL",
          [req.context.actor.store_id, id],
        );
      await audit(db, req.context, "USER_UPDATED", "user", id, input.reason);
      return visible(row);
    });
  });
  app.post(
    "/api/v1/users/:id/password",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      manager(req.context);
      const id = identity.parse((req.params as { id: string }).id),
        input = resetPasswordCommand.parse(req.body);
      requireThat(
        id !== req.context.actor.id,
        "FORBIDDEN",
        403,
        "Use your own password-change form",
      );
      const hash = await hashPassword(input.new_password);
      return transaction(pool, async (db) => {
        await authorizeManager(db, req);
        const row = (
          await db.query(
            `UPDATE users SET password_hash=$4,security_version=security_version+1 WHERE store_id=$1 AND id=$2 AND security_version=$3 RETURNING ${projection}`,
            [req.context.actor.store_id, id, input.version, hash],
          )
        ).rows[0];
        requireThat(
          row,
          "VERSION_CONFLICT",
          409,
          "Account changed or is unavailable",
        );
        await revoke(db, req.context.actor.store_id, id);
        await audit(
          db,
          req.context,
          "USER_PASSWORD_RESET",
          "user",
          id,
          input.reason,
        );
        return visible(row);
      });
    },
  );
  for (const operation of ["password", "revoke-sessions"] as const) {
    app.post(
      `/api/v1/auth/${operation}`,
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const input = (
          operation === "password"
            ? changePasswordCommand
            : revokeSessionsCommand
        ).parse(req.body);
        const current = (
          await pool.query(
            "SELECT * FROM users WHERE store_id=$1 AND id=$2 AND active",
            [req.context.actor.store_id, req.context.actor.id],
          )
        ).rows[0];
        requireThat(
          current &&
            (await passwordMatches(
              input.current_password,
              current.password_hash,
            )),
          "AUTH_REQUIRED",
          401,
          "Current password is incorrect",
        );
        const next =
          "new_password" in input && typeof input.new_password === "string"
            ? input.new_password
            : undefined;
        requireThat(
          !next || next !== input.current_password,
          "VALIDATION_ERROR",
          422,
          "Choose a different password",
        );
        const hash = next ? await hashPassword(next) : current.password_hash;
        return transaction(pool, async (db) => {
          const row = (
            await db.query(
              "UPDATE users SET password_hash=$4,security_version=security_version+1 WHERE store_id=$1 AND id=$2 AND security_version=$3 AND password_hash=$5 AND active RETURNING *",
              [
                req.context.actor.store_id,
                req.context.actor.id,
                req.securityVersion,
                hash,
                current.password_hash,
              ],
            )
          ).rows[0];
          requireThat(
            row,
            "AUTH_REQUIRED",
            401,
            "Account changed; sign in again",
          );
          await revoke(db, row.store_id, row.id);
          await audit(
            db,
            req.context,
            operation === "password"
              ? "USER_PASSWORD_CHANGED"
              : "USER_SESSIONS_REVOKED",
            "user",
            row.id,
          );
          return issueSession(db, reply, config, row);
        });
      },
    );
  }
}
