import { describe, it, expect } from "vitest";
import { allocateRefund, lineTax, sumTaxByCode } from "../../packages/domain/tax.ts";

describe("tax calculations", () => {
  it("calculates inclusive and exclusive taxes per line", () => {
    expect(lineTax({ mode: "inclusive", unitPriceMinor: 1000, quantity: 1, rateBps: 900 })).toEqual({ netMinor: 917, taxMinor: 83, grossMinor: 1000 });
    expect(lineTax({ mode: "exclusive", unitPriceMinor: 1000, quantity: 1, rateBps: 900 })).toEqual({ netMinor: 1000, taxMinor: 90, grossMinor: 1090 });
    expect(lineTax({ mode: "exclusive", unitPriceMinor: 1000, quantity: 1, rateBps: 1000 })).toMatchObject({ taxMinor: 100 });
    expect(lineTax({ mode: "exclusive", unitPriceMinor: 1000, quantity: 1, rateBps: 800 })).toMatchObject({ taxMinor: 80 });
    expect(lineTax({ mode: "inclusive", unitPriceMinor: 999, quantity: 1, rateBps: 900 })).toEqual({ netMinor: 917, taxMinor: 82, grossMinor: 999 });
  });

  it("handles off mode, discounts, and half-up rounding", () => {
    expect(lineTax({ mode: "off", unitPriceMinor: 100, quantity: 2, rateBps: 900 })).toEqual({ netMinor: 200, taxMinor: 0, grossMinor: 200 });
    expect(lineTax({ mode: "exclusive", unitPriceMinor: 1000, quantity: 1, discountMinor: 100, rateBps: 1000 })).toEqual({ netMinor: 900, taxMinor: 90, grossMinor: 990 });
    expect(lineTax({ mode: "inclusive", unitPriceMinor: 1000, quantity: 1, discountMinor: 100, rateBps: 1000 })).toEqual({ netMinor: 818, taxMinor: 82, grossMinor: 900 });
    expect(lineTax({ mode: "exclusive", unitPriceMinor: 10, quantity: 1, rateBps: 500 })).toMatchObject({ taxMinor: 1 });
  });

  it("groups tax by code in first-seen order", () => {
    expect(sumTaxByCode([
      { code: "GST", label: "GST", rateBps: 900, netMinor: 1000, taxMinor: 90 },
      { code: "SST", label: "Sales tax", rateBps: 1000, netMinor: 500, taxMinor: 50 },
      { code: "GST", label: "GST", rateBps: 900, netMinor: 200, taxMinor: 18 },
    ])).toEqual([
      { code: "GST", label: "GST", rateBps: 900, netMinor: 1200, taxMinor: 108 },
      { code: "SST", label: "Sales tax", rateBps: 1000, netMinor: 500, taxMinor: 50 },
    ]);
  });

  it("rejects duplicate tax codes with conflicting rates or labels", () => {
    expect(() => sumTaxByCode([
      { code: "GST", label: "GST", rateBps: 900, netMinor: 100, taxMinor: 9 },
      { code: "GST", label: "GST", rateBps: 800, netMinor: 100, taxMinor: 8 },
    ])).toThrow(/GST.*conflicting rate or label/);
    expect(() => sumTaxByCode([
      { code: "GST", label: "GST", rateBps: 900, netMinor: 100, taxMinor: 9 },
      { code: "GST", label: "Goods tax", rateBps: 900, netMinor: 100, taxMinor: 9 },
    ])).toThrow(/GST.*conflicting rate or label/);
  });

  it("allocates sequential partial refunds cumulatively", () => {
    const line = { netMinor: 917, taxMinor: 82, quantity: 3 };
    const refunds = [0, 1, 2].map((alreadyRefundedUnits) =>
      allocateRefund(line, alreadyRefundedUnits, 1),
    );
    expect(refunds).toEqual([
      { netMinor: 306, taxMinor: 27 },
      { netMinor: 305, taxMinor: 28 },
      { netMinor: 306, taxMinor: 27 },
    ]);
    expect(refunds.reduce((sum, refund) => sum + refund.netMinor, 0)).toBe(917);
    expect(refunds.reduce((sum, refund) => sum + refund.taxMinor, 0)).toBe(82);
  });

  it("rejects invalid amounts and over-refunds", () => {
    for (const value of [-1, 1.5, Number.NaN])
      expect(() => lineTax({ mode: "exclusive", unitPriceMinor: value, quantity: 1, rateBps: 900 })).toThrow();
    expect(() => lineTax({ mode: "exclusive", unitPriceMinor: 1, quantity: 0, rateBps: 900 })).toThrow();
    expect(() => lineTax({ mode: "exclusive", unitPriceMinor: 10, quantity: 1, discountMinor: 11, rateBps: 900 })).toThrow();
    expect(() => allocateRefund({ netMinor: 10, taxMinor: 1, quantity: 2 }, 2, 1)).toThrow(/remaining/);
    expect(() => allocateRefund({ netMinor: 10, taxMinor: 1, quantity: 2 }, -1, 1)).toThrow();
  });
});
