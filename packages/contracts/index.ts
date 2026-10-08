import { z } from "zod";
const id = z.string().uuid();
const money = z.number().int().min(0).max(1_000_000_000);
const quantity = z.number().int().min(1).max(999);
export const saleLine = z
  .object({
    line_id: id,
    product_id: id,
    price_revision_id: id,
    sku_snapshot: z.string().min(1).max(64),
    name_snapshot: z.string().min(1).max(160),
    quantity,
    unit_price_minor: money,
    discount_minor: money,
    tax_bps: z.number().int().min(0).max(10000),
    tax_minor: money,
    line_total_minor: money,
  })
  .strict();
export const payment = z
  .object({
    method: z.enum(["CASH", "CARD_MANUAL", "PAYNOW_MANUAL", "DUITNOW_MANUAL"]),
    amount_applied_minor: money,
    tender_minor: money,
    change_minor: money,
    external_reference: z.string().trim().min(1).max(120).optional(),
    operator_verified_at: z.string().datetime().optional(),
  })
  .strict();
export const saleCommand = z
  .object({
    schema_version: z.literal(1),
    client_sale_id: id,
    device_id: id,
    shift_id: id,
    client_created_at: z.string().datetime(),
    was_offline: z.boolean(),
    offline_permit_id: id.optional(),
    currency: z.enum(["SGD", "MYR"]),
    lines: z.array(saleLine).min(1).max(100),
    payment,
    gross_minor: money,
    discount_minor: money,
    tax_minor: money,
    total_minor: money,
  })
  .strict()
  .refine(
    (s) => new Set(s.lines.map((l) => l.line_id)).size === s.lines.length,
    "Duplicate line identity",
  );
export type SaleCommand = z.infer<typeof saleCommand>;
export const productWrite = z
  .object({
    name: z.string().trim().min(1).max(160),
    sku: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .transform((s) => s.toUpperCase()),
    barcode: z.string().trim().max(80).nullable().optional(),
    category_id: id,
    unit_price_minor: money,
    cost_minor: money.default(0),
    tax_bps: z.literal(0).default(0),
    low_stock_threshold: z.number().int().min(0).max(999999).default(6),
    active: z.boolean().default(true),
    expected_version: z.number().int().positive().optional(),
  })
  .strict();
export const refundCommand = z
  .object({
    client_refund_id: id,
    original_sale_id: id,
    shift_id: id,
    reason: z.string().trim().min(1).max(500),
    method: z
      .enum(["CASH", "CARD_MANUAL", "PAYNOW_MANUAL", "DUITNOW_MANUAL"])
      .default("CASH"),
    external_reference: z.string().trim().min(1).max(120).optional(),
    operator_verified_at: z.string().datetime().optional(),
    lines: z
      .array(
        z
          .object({ original_sale_line_id: id, quantity, restock: z.boolean() })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (s) =>
      new Set(s.lines.map((l) => l.original_sale_line_id)).size ===
      s.lines.length,
    "Duplicate return line",
  );
export type RefundCommand = z.infer<typeof refundCommand>;
export type Product = {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  category_id: string;
  category_name: string;
  price_revision_id: string;
  unit_price_minor: number;
  tax_bps: number;
  quantity: number;
  balance_version: number;
  version: number;
  active: boolean;
  low_stock_threshold: number;
  cost_minor?: number;
};
export type Actor = {
  id: string;
  store_id: string;
  display_name: string;
  role: "CASHIER" | "MANAGER";
};
export type Shift = {
  id: string;
  device_id: string;
  opened_by: string;
  state: "OPEN" | "CLOSED";
  business_date: string;
  opening_float_minor: number;
  expected_cash_minor: number;
  version: number;
};
export type Permit = {
  id: string;
  issued_at: string;
  expires_at: string;
  max_sales: number;
  signed_claims: { revisions: string[]; discount_bps: number };
  signature: string;
};
export type Bootstrap = {
  demo: boolean;
  store: {
    id: string;
    name: string;
    currency: string;
    timezone: string;
    tax_enabled: boolean;
  };
  user: Actor;
  devices: { id: string; name: string; revoked_at: string | null }[];
  csrf_token: string;
  server_time: string;
};
export type Posted = {
  sale_id: string;
  client_sale_id: string;
  receipt_no: string;
  posted_at: string;
  business_date: string;
  total_minor: number;
  sync_cursor: string;
  review_flags: string[];
};
