import { requireThat } from "./db.ts";
export function cursor(value: unknown): number {
  if (value === undefined) return 0;
  requireThat(
    typeof value === "string" && value.length <= 100,
    "VALIDATION_ERROR",
  );
  let text = "";
  try {
    text = Buffer.from(value, "base64url").toString();
  } catch {
    /* Validate below. */
  }
  requireThat(/^offset:\d+$/.test(text), "VALIDATION_ERROR");
  const n = Number(text.slice(7));
  requireThat(
    Number.isSafeInteger(n) && n >= 0 && n <= 100000,
    "VALIDATION_ERROR",
  );
  return n;
}
export const nextCursor = (offset: number) =>
  Buffer.from("offset:" + offset).toString("base64url");
