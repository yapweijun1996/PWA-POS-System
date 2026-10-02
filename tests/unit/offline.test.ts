import { describe, expect, it } from "vitest";
import { offlineAllowed } from "../../apps/web/src/offline.ts";
import type {
  Bootstrap,
  Permit,
  Product,
  Shift,
} from "../../packages/contracts/index.ts";
const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
const boot: Bootstrap = {
  demo: true,
  store: {
    id: ids[0],
    name: "Test store",
    currency: "SGD",
    timezone: "Asia/Singapore",
    tax_enabled: false,
  },
  user: {
    id: ids[1],
    store_id: ids[0],
    display_name: "Test operator",
    role: "CASHIER",
  },
  devices: [{ id: ids[2], name: "Test terminal", revoked_at: null }],
  csrf_token: "",
  server_time: "2026-10-02T00:00:00.000Z",
};
const shift: Shift = {
  id: ids[3],
  device_id: ids[2],
  opened_by: ids[1],
  state: "OPEN",
  business_date: "2026-10-02",
  opening_float_minor: 0,
  expected_cash_minor: 0,
  version: 1,
};
const claims = {
  revisions: [ids[4]],
  discount_bps: 0,
  user_id: ids[1],
  store_id: ids[0],
  device_id: ids[2],
  shift_id: ids[3],
};
const permit: Permit = {
  id: crypto.randomUUID(),
  issued_at: boot.server_time,
  expires_at: "2026-10-02T12:00:00.000Z",
  max_sales: 200,
  signature: "test",
  signed_claims: claims,
};
const product: Product = {
  id: crypto.randomUUID(),
  sku: "TEST",
  name: "Test item",
  barcode: null,
  category_id: crypto.randomUUID(),
  category_name: "General",
  price_revision_id: ids[4],
  unit_price_minor: 100,
  tax_bps: 0,
  quantity: 2,
  version: 1,
  balance_version: 1,
  active: true,
  low_stock_threshold: 1,
};
function input() {
  return {
    anchor: {
      server: Date.parse(boot.server_time),
      monotonic: 100,
      wall: 1000,
    },
    permit,
    shift,
    boot,
    cart: [
      { line_id: crypto.randomUUID(), product, quantity: 1, discount_minor: 0 },
    ],
    monotonic: 1100,
    wall: 2000,
  };
}
describe("offline cash authorization", () => {
  it("accepts a verified open shift and a covered price revision", () =>
    expect(offlineAllowed(input())).toBe(true));
  it("rejects expiry, wall-clock rollback, missing anchor and non-monotonic time", () => {
    const value = input();
    expect(
      offlineAllowed({ ...value, monotonic: 43200100, wall: 43201000 }),
    ).toBe(false);
    expect(offlineAllowed({ ...value, wall: -10000 })).toBe(false);
    expect(offlineAllowed({ ...value, anchor: null })).toBe(false);
    expect(offlineAllowed({ ...value, monotonic: 99 })).toBe(false);
  });
  it("rejects revoked terminals, closed shifts and foreign operator permits", () => {
    const value = input();
    const foreignClaims = { ...claims, user_id: crypto.randomUUID() };
    expect(
      offlineAllowed({
        ...value,
        boot: {
          ...boot,
          devices: [{ ...boot.devices[0], revoked_at: boot.server_time }],
        },
      }),
    ).toBe(false);
    expect(
      offlineAllowed({ ...value, shift: { ...shift, state: "CLOSED" } }),
    ).toBe(false);
    expect(
      offlineAllowed({
        ...value,
        permit: {
          ...permit,
          signed_claims: foreignClaims,
        },
      }),
    ).toBe(false);
  });
  it("rejects uncovered prices, discounts and malformed time claims", () => {
    const value = input();
    expect(
      offlineAllowed({
        ...value,
        cart: [
          {
            ...value.cart[0],
            product: { ...product, price_revision_id: crypto.randomUUID() },
          },
        ],
      }),
    ).toBe(false);
    expect(
      offlineAllowed({
        ...value,
        cart: [{ ...value.cart[0], discount_minor: 1 }],
      }),
    ).toBe(false);
    expect(
      offlineAllowed({
        ...value,
        permit: { ...permit, expires_at: "invalid" },
      }),
    ).toBe(false);
  });
});
