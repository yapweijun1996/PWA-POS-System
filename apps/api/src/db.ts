import pg from "pg";
pg.types.setTypeParser(1082, (value) => value);
export function database(url: string) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  pool.on("error", () => {});
  return pool;
}
export async function transaction<T>(
  pool: pg.Pool,
  work: (db: pg.PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const result = await work(db);
      await db.query("COMMIT");
      return result;
    } catch (e) {
      await db.query("ROLLBACK").catch(() => {});
      if (
        attempt < 2 &&
        ["40001", "40P01"].includes((e as { code: string }).code)
      )
        continue;
      throw e;
    } finally {
      db.release();
    }
  }
}
export function numbers<T>(value: T): T {
  if (Array.isArray(value)) return value.map(numbers) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        typeof v === "string" &&
        /(?:_minor|_version|^version$|^count$|^orders$|^receipt_seq$|^returned$)/.test(
          k,
        )
          ? Number(v)
          : numbers(v),
      ]),
    ) as T;
  }
  return value;
}
export class Problem extends Error {
  constructor(
    public code: string,
    public status = 422,
    message = code,
    public retryable = false,
  ) {
    super(message);
  }
}
export function requireThat(
  condition: unknown,
  code: string,
  status = 422,
  message = code,
): asserts condition {
  if (!condition) throw new Problem(code, status, message);
}
