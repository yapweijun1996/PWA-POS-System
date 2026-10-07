export type TaxMode = "off" | "exclusive" | "inclusive";

type TaxLineInput = {
  mode: TaxMode;
  unitPriceMinor: number;
  quantity: number;
  discountMinor?: number;
  rateBps: number;
};

function integer(value: number, name: string, min = 0): number {
  if (!Number.isSafeInteger(value) || value < min)
    throw new Error(`${name} must be a nonnegative integer`);
  return value;
}

function result(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Calculated amount exceeds safe integer range");
  return Number(value);
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

export function lineTax(input: TaxLineInput) {
  if (!["off", "exclusive", "inclusive"].includes(input.mode))
    throw new Error("Invalid tax mode");
  const price = BigInt(integer(input.unitPriceMinor, "unitPriceMinor"));
  const quantity = BigInt(integer(input.quantity, "quantity", 1));
  const rate = BigInt(integer(input.rateBps, "rateBps"));
  const amount = price * quantity;
  const discount = BigInt(integer(input.discountMinor ?? 0, "discountMinor"));
  if (discount > amount) throw new Error("Discount cannot exceed line amount");
  const basis = amount - discount;
  if (input.mode === "off") {
    const netMinor = result(basis);
    return { netMinor, taxMinor: 0, grossMinor: netMinor };
  }
  if (input.mode === "exclusive") {
    const tax = roundHalfUp(basis * rate, 10000n);
    const netMinor = result(basis);
    const taxMinor = result(tax);
    return { netMinor, taxMinor, grossMinor: result(basis + tax) };
  }
  const gross = basis;
  const net = roundHalfUp(gross * 10000n, 10000n + rate);
  return {
    netMinor: result(net),
    taxMinor: result(gross - net),
    grossMinor: result(gross),
  };
}

export type TaxBreakdownInput = {
  code: string;
  label: string;
  rateBps: number;
  netMinor: number;
  taxMinor: number;
};

export function sumTaxByCode(lines: TaxBreakdownInput[]) {
  const grouped = new Map<string, TaxBreakdownInput>();
  for (const line of lines) {
    integer(line.rateBps, "rateBps");
    integer(line.netMinor, "netMinor");
    integer(line.taxMinor, "taxMinor");
    const prior = grouped.get(line.code);
    if (prior) {
      if (prior.rateBps !== line.rateBps || prior.label !== line.label)
        throw new Error(`Tax code ${line.code} has conflicting rate or label`);
      prior.netMinor = result(BigInt(prior.netMinor) + BigInt(line.netMinor));
      prior.taxMinor = result(BigInt(prior.taxMinor) + BigInt(line.taxMinor));
    } else grouped.set(line.code, { ...line });
  }
  return [...grouped.values()];
}

export function allocateRefund(
  line: { netMinor: number; taxMinor: number; quantity: number },
  alreadyRefundedUnits: number,
  refundUnits: number,
) {
  const quantity = integer(line.quantity, "quantity", 1);
  const net = integer(line.netMinor, "netMinor");
  const tax = integer(line.taxMinor, "taxMinor");
  const refunded = integer(alreadyRefundedUnits, "alreadyRefundedUnits");
  const units = integer(refundUnits, "refundUnits", 1);
  if (refunded > quantity || units > quantity - refunded)
    throw new Error("Refund units exceed the remaining line quantity");
  const allocated = (amount: number, count: number) =>
    roundHalfUp(BigInt(amount) * BigInt(count), BigInt(quantity));
  return {
    netMinor: result(allocated(net, refunded + units) - allocated(net, refunded)),
    taxMinor: result(allocated(tax, refunded + units) - allocated(tax, refunded)),
  };
}
