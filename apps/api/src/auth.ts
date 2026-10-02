import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { digest, type Context } from "./context.ts";
import { requireThat } from "./db.ts";
import type { Config } from "./config.ts";
declare module "fastify" {
  interface FastifyRequest {
    context: Context;
    csrf: string;
    sessionHash: string;
  }
}
function passwordMatches(pass: string, hash: string) {
  const [salt, expected] = hash.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(pass, salt, 64);
  const decoded = Buffer.from(expected, "hex");
  return decoded.length === actual.length && timingSafeEqual(decoded, actual);
}
export async function sessions(
  app: FastifyInstance,
  pool: pg.Pool,
  config: Config,
) {
  app.decorateRequest("context");
  app.decorateRequest("csrf", "");
  app.decorateRequest("sessionHash", "");
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
    requireThat(token, "AUTH_REQUIRED", 401);
    const hash = digest(token);
    const s = (
      await pool.query(
        "SELECT s.*,u.display_name,u.role FROM sessions s JOIN users u ON (u.store_id,u.id)=(s.store_id,s.user_id) WHERE s.id_hash=$1 AND u.active AND s.expires_at>now() AND s.last_seen_at>now()-interval '30 minutes'",
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
    user: Record<string, string>,
    old?: string,
  ) {
    const token = randomBytes(32).toString("base64url"),
      csrf = randomBytes(32).toString("hex");
    if (old)
      await pool.query("DELETE FROM sessions WHERE id_hash=$1", [digest(old)]);
    await pool.query(
      "INSERT INTO sessions(id_hash,store_id,user_id,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '12 hours')",
      [digest(token), user.store_id, user.id, csrf],
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
  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const input = z
        .object({
          email: z
            .string()
            .email()
            .max(254)
            .transform((s) => s.toLowerCase().trim()),
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
      const hash =
        u?.password_hash ??
        "00000000000000000000000000000000:" + "0".repeat(128);
      const ok = passwordMatches(input.password, hash);
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
      const u = (
        await pool.query("SELECT * FROM users WHERE email=$1 AND active", [
          role === "MANAGER" ? "manager@example.test" : "cashier@example.test",
        ])
      ).rows[0];
      requireThat(u, "SERVICE_UNAVAILABLE", 503);
      return login(reply, u, req.cookies.counter_session);
    },
  );
  app.post("/api/v1/auth/logout", async (req, reply) => {
    await pool.query("DELETE FROM sessions WHERE id_hash=$1", [
      req.sessionHash,
    ]);
    reply.clearCookie("counter_session", { path: "/" });
    return reply.code(204).send();
  });
}
