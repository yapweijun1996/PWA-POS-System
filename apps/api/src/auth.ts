import { createHmac, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { type Context } from "./context.ts";
import { requireThat, transaction } from "./db.ts";
import type { Config } from "./config.ts";
import { dummyPasswordHash, passwordMatches } from "./passwords.ts";
declare module "fastify" {
  interface FastifyRequest {
    context: Context;
    csrf: string;
    sessionHash: string;
    securityVersion: string;
  }
}
export type SessionUser = {
  id: string;
  store_id: string;
  display_name: string;
  role: "MANAGER" | "CASHIER";
  security_version: string;
};
export function sessionDigest(token: string, config: Config): string {
  const key = createHmac("sha256", config.secret)
    .update("counter-pos/session-key/v1")
    .digest();
  return createHmac("sha256", key).update(token).digest("hex");
}
export async function issueSession(
  db: pg.PoolClient,
  reply: FastifyReply,
  config: Config,
  user: SessionUser,
  oldHash?: string,
) {
  const token = randomBytes(32).toString("base64url"),
    csrf = randomBytes(32).toString("hex");
  if (oldHash)
    await db.query("DELETE FROM sessions WHERE id_hash=$1", [oldHash]);
  await db.query(
    "INSERT INTO sessions(id_hash,store_id,user_id,csrf_token,security_version,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '12 hours')",
    [
      sessionDigest(token, config),
      user.store_id,
      user.id,
      csrf,
      user.security_version,
    ],
  );
  reply.setCookie("counter_session", token, {
    httpOnly: true,
    secure: config.production,
    sameSite: "strict",
    path: "/",
    maxAge: 43200,
  });
  return {
    user: { id: user.id, display_name: user.display_name, role: user.role },
    csrf_token: csrf,
  };
}
export async function sessions(
  app: FastifyInstance,
  pool: pg.Pool,
  config: Config,
) {
  app.decorateRequest("context");
  app.decorateRequest("csrf", "");
  app.decorateRequest("sessionHash", "");
  app.decorateRequest("securityVersion", "");
  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/api/")) return;
    if (!["GET", "HEAD"].includes(req.method))
      requireThat(
        req.headers.origin === config.origin,
        "FORBIDDEN",
        403,
        "Invalid request origin",
      );
    if (req.url === "/api/v1/auth/login" || req.url === "/api/v1/demo/login")
      return;
    const token = req.cookies.counter_session;
    requireThat(
      token && /^[A-Za-z0-9_-]{43}$/.test(token),
      "AUTH_REQUIRED",
      401,
    );
    const hash = sessionDigest(token, config);
    const s = (
      await pool.query(
        "SELECT s.*,u.display_name,u.role FROM sessions s JOIN users u ON (u.store_id,u.id)=(s.store_id,s.user_id) WHERE s.id_hash=$1 AND u.active AND u.security_version=s.security_version AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes'",
        [hash],
      )
    ).rows[0];
    requireThat(s, "AUTH_REQUIRED", 401);
    req.context = {
      actor: {
        id: s.user_id,
        store_id: s.store_id,
        display_name: s.display_name,
        role: s.role,
      },
      requestId: req.id,
    };
    req.csrf = s.csrf_token;
    req.sessionHash = hash;
    req.securityVersion = s.security_version;
    if (!["GET", "HEAD"].includes(req.method))
      requireThat(
        req.headers["x-csrf-token"] === s.csrf_token,
        "FORBIDDEN",
        403,
        "Invalid CSRF token",
      );
    await pool.query(
      "UPDATE sessions SET last_seen_at=now() WHERE id_hash=$1",
      [hash],
    );
  });
  async function login(
    reply: FastifyReply,
    user: SessionUser & { password_hash: string },
    old?: string,
  ) {
    return transaction(pool, async (db) => {
      const current = (
        await db.query(
          "SELECT * FROM users WHERE store_id=$1 AND id=$2 AND active FOR UPDATE",
          [user.store_id, user.id],
        )
      ).rows[0];
      // A concurrent password/reset/role change must not issue a stale valid session.
      requireThat(
        current &&
          current.password_hash === user.password_hash &&
          current.security_version === user.security_version,
        "AUTH_REQUIRED",
        401,
        "Account changed; sign in again",
      );
      await db.query("DELETE FROM sessions WHERE expires_at<now()");
      return issueSession(
        db,
        reply,
        config,
        current,
        old ? sessionDigest(old, config) : undefined,
      );
    });
  }
  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const input = z
        .object({
          email: z
            .string()
            .trim()
            .email()
            .max(254)
            .transform((s) => s.toLowerCase()),
          password: z.string().min(1).max(200),
        })
        .strict()
        .parse(req.body);
      const users = (
        await pool.query(
          "SELECT * FROM users WHERE lower(email)=$1 AND active",
          [input.email],
        )
      ).rows;
      const u = users.length === 1 ? users[0] : null;
      const ok = await passwordMatches(
        input.password,
        u?.password_hash ?? dummyPasswordHash,
      );
      requireThat(ok && u, "AUTH_REQUIRED", 401, "Invalid email or password");
      return login(reply, u, req.cookies.counter_session);
    },
  );
  app.post(
    "/api/v1/demo/login",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      requireThat(config.demo, "NOT_FOUND", 404);
      const { role } = z
        .object({ role: z.enum(["MANAGER", "CASHIER"]) })
        .strict()
        .parse(req.body);
      const users = (
        await pool.query("SELECT * FROM users WHERE email=$1 AND active", [
          role === "MANAGER" ? "manager@example.test" : "cashier@example.test",
        ])
      ).rows;
      requireThat(users.length === 1, "SERVICE_UNAVAILABLE", 503);
      return login(reply, users[0], req.cookies.counter_session);
    },
  );
  app.post("/api/v1/auth/logout", async (req, reply) => {
    await pool.query("DELETE FROM sessions WHERE id_hash=$1", [
      req.sessionHash,
    ]);
    reply.clearCookie("counter_session", {
      path: "/",
      secure: config.production,
      sameSite: "strict",
      httpOnly: true,
    });
    return reply.code(204).send();
  });
}
