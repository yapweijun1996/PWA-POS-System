import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  lineMoney,
  saleMoney,
  refundAllocation,
  parseMoney,
  canonical,
} from "../../packages/domain/money.ts";
import { saleCommand } from "../../packages/contracts/index.ts";
const fixture = JSON.parse(readFileSync("specs/example-sale.json", "utf8"));
describe("bounded integer money", () => {
  it("T01 canonical basket reconciles 1400 due / 2000 tender / 600 change", () => {
    expect(saleMoney(fixture.lines)).toEqual({
      gross_minor: 1400,
      discount_minor: 0,
      tax_minor: 0,
      total_minor: 1400,
    });
    expect(fixture.payment.tender_minor - fixture.payment.change_minor).toBe(
      1400,
    );
    expect(saleCommand.safeParse(fixture).success).toBe(true);
  });
  it("rejects floats, unsafe quantities, intermediate overflow and additional fields", () => {
    for (const line of [
      { quantity: 0, unit_price_minor: 1, discount_minor: 0, tax_bps: 0 },
      { quantity: 1.1, unit_price_minor: 1, discount_minor: 0, tax_bps: 0 },
      { quantity: 999, unit_price_minor: 1e9, discount_minor: 0, tax_bps: 0 },
      { quantity: 1, unit_price_minor: 100, discount_minor: 101, tax_bps: 0 },
    ])
      expect(() => lineMoney(line)).toThrow();
    expect(
      saleCommand.safeParse({ ...fixture, store_id: "tamper" }).success,
    ).toBe(false);
    expect(() =>
      saleMoney(
        Array(100).fill({
          quantity: 999,
          unit_price_minor: 11000,
          discount_minor: 0,
          tax_bps: 0,
        }),
      ),
    ).toThrow();
  });
  it("exclusive artificial tax rounds half up", () => {
    expect(
      lineMoney({
        quantity: 1,
        unit_price_minor: 10,
        discount_minor: 0,
        tax_bps: 500,
      }).tax_minor,
    ).toBe(1);
  });
  it("T10 cumulative partial refunds preserve every net and tax cent", () => {
    for (let q = 1; q <= 99; q++) {
      const line = {
        quantity: q,
        unit_price_minor: 7,
        discount_minor: 3,
        tax_bps: 500,
      };
      let net = 0,
        tax = 0;
      for (let i = 0; i < q; i++) {
        const r = refundAllocation(line, i, 1);
        net += r.net_minor;
        tax += r.tax_minor;
      }
      const original = lineMoney(line);
      expect(net).toBe(original.net_minor);
      expect(tax).toBe(original.tax_minor);
    }
    expect(() =>
      refundAllocation(
        { quantity: 2, unit_price_minor: 10, discount_minor: 0, tax_bps: 0 },
        2,
        1,
      ),
    ).toThrow();
  });
  it("parses decimal strings without binary floating multiplication", () => {
    expect(parseMoney("14.00")).toBe(1400);
    expect(parseMoney("0.29")).toBe(29);
    for (const input of ["-1", "NaN", "1.001", "1e3", ""])
      expect(() => parseMoney(input)).toThrow();
  });
  it("canonicalizes object key order but preserves ordered lines", () => {
    expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
});
