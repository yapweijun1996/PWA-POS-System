export const MONEY_CAP = 1_000_000_000;
export function integer(value: number, min = 0, max = MONEY_CAP): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error("Amount or quantity outside supported bounds");
  return value;
}
function bounded(value: bigint): number {
  if (value < 0n || value > BigInt(MONEY_CAP))
    throw new Error("Money limit exceeded");
  return Number(value);
}
export type PriceLine = {
  quantity: number;
  unit_price_minor: number;
  discount_minor: number;
  tax_bps: number;
};
export function lineMoney(line: PriceLine) {
  const q = BigInt(integer(line.quantity, 1, 999));
  const p = BigInt(integer(line.unit_price_minor));
  const gross = bounded(q * p);
  const discount = integer(line.discount_minor, 0, gross);
  const net = gross - discount;
  const tax = bounded(
    (BigInt(net) * BigInt(integer(line.tax_bps, 0, 10000)) + 5000n) / 10000n,
  );
  return {
    gross_minor: gross,
    discount_minor: discount,
    net_minor: net,
    tax_minor: tax,
    line_total_minor: bounded(BigInt(net) + BigInt(tax)),
  };
}
export function saleMoney(lines: PriceLine[]) {
  if (lines.length < 1 || lines.length > 100)
    throw new Error("A sale needs 1–100 lines");
  const calculated = lines.map(lineMoney);
  const sum = (key: keyof ReturnType<typeof lineMoney>) =>
    bounded(calculated.reduce((s, l) => s + BigInt(l[key]), 0n));
  return {
    gross_minor: sum("gross_minor"),
    discount_minor: sum("discount_minor"),
    tax_minor: sum("tax_minor"),
    total_minor: sum("line_total_minor"),
  };
}
export function refundAllocation(
  line: PriceLine,
  returned: number,
  quantity: number,
) {
  integer(returned, 0, line.quantity);
  integer(quantity, 1, line.quantity - returned);
  const m = lineMoney(line);
  const entitled = (amount: number, q: number) =>
    Number(
      (BigInt(amount) * BigInt(q) + BigInt(Math.floor(line.quantity / 2))) /
        BigInt(line.quantity),
    );
  const net =
    entitled(m.net_minor, returned + quantity) -
    entitled(m.net_minor, returned);
  const tax =
    entitled(m.tax_minor, returned + quantity) -
    entitled(m.tax_minor, returned);
  return { net_minor: net, tax_minor: tax, total_minor: net + tax };
}
export function parseMoney(input: string) {
  if (!/^\d{1,8}(\.\d{0,2})?$/.test(input))
    throw new Error("Enter a nonnegative amount with at most two decimals");
  const [a, b = ""] = input.split(".");
  return integer(Number(a) * 100 + Number(b.padEnd(2, "0")));
}
export const formatMoney = (minor: number, currency = "SGD") =>
  (currency === "SGD" ? "S$" : "RM") +
  new Intl.NumberFormat("en-SG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
