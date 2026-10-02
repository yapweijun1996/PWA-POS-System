import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import YAML from "yaml";
import { z } from "zod";
import {
  saleCommand,
  saleLine,
  payment,
  productWrite,
  refundCommand,
} from "../packages/contracts/index.ts";
import {
  createUserCommand,
  updateUserCommand,
  resetPasswordCommand,
  changePasswordCommand,
  revokeSessionsCommand,
} from "../apps/api/src/accounts.ts";
import { snapshotQuery } from "../apps/api/src/snapshot.ts";
const spec = YAML.parse(await readFile("specs/openapi.yaml", "utf8"));
spec.info = {
  title: "Counter POS V1 API",
  version: "1.0.0",
  description:
    "Implemented local single-store API. Same-origin cookie and CSRF authentication. Cash-only offline; external methods are manual records. Runtime validation and financial invariants also require the shared domain rules. See docs/adr/001-v1-implementation.md.",
};
spec.servers = [{ url: "/api/v1", description: "Same-origin application API" }];
const schema = spec.components.schemas;
function json(value: z.ZodType) {
  const result = z.toJSONSchema(value, { io: "input", unrepresentable: "any" });
  delete result.$schema;
  return result;
}
const id = { type: "string", format: "uuid" },
  money = { type: "integer", minimum: 0, maximum: 1000000000 },
  text = { type: "string", maxLength: 500 },
  reason = { ...text, minLength: 1 };
function object(
  properties: Record<string, unknown>,
  required = Object.keys(properties),
  additional = false,
) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: additional,
  };
}
schema.SaleCommand = json(saleCommand);
schema.SaleLine = json(saleLine);
schema.Payment = json(payment);
if (schema.Payment.properties.external_reference)
  schema.Payment.properties.external_reference.type = ["string", "null"];
schema.ProductWrite = json(productWrite);
schema.ProductUpdate = json(productWrite);
schema.RefundCommand = json(refundCommand);
schema.StockReceipt = object({
  client_event_id: id,
  product_id: id,
  quantity: { type: "integer", minimum: 1, maximum: 999999 },
  reason,
});
schema.StockAdjustment = object({
  client_event_id: id,
  product_id: id,
  counted_quantity: { type: "integer", minimum: 0, maximum: 999999 },
  expected_version: { type: "integer", minimum: 1 },
  reason,
});
schema.ShiftCount = object({ counted_minor: money, reason: text }, [
  "counted_minor",
]);
schema.ShiftClose = object(
  { counted_minor: money, reason: text, reconciliation_id: id },
  ["counted_minor", "reconciliation_id"],
);
schema.Reconciliation = object({
  device_id: id,
  sale_ids: { type: "array", maxItems: 10000, items: id },
  pending_count: { type: "integer", minimum: 0 },
});
schema.ReconciliationResult = object({ reconciliation_id: id });
schema.OfflinePermit = object({
  id,
  issued_at: { type: "string", format: "date-time" },
  expires_at: { type: "string", format: "date-time" },
  max_sales: { type: "integer", const: 200 },
  signed_claims: { type: "object", additionalProperties: true },
  signature: { type: "string", pattern: "^[a-f0-9]{64}$" },
});
schema.Product = object(
  {
    id,
    sku: { type: "string" },
    name: { type: "string" },
    barcode: { type: ["string", "null"] },
    category_id: id,
    category_name: { type: "string" },
    price_revision_id: id,
    unit_price_minor: money,
    tax_bps: { type: "integer", const: 0 },
    quantity: { type: "integer" },
    balance_version: { type: "integer" },
    active: { type: "boolean" },
    version: { type: "integer" },
    low_stock_threshold: { type: "integer" },
    cost_minor: money,
  },
  [
    "id",
    "sku",
    "name",
    "barcode",
    "category_id",
    "category_name",
    "price_revision_id",
    "unit_price_minor",
    "tax_bps",
    "quantity",
    "balance_version",
    "active",
    "version",
    "low_stock_threshold",
  ],
);
schema.ProductsPage = object({
  items: {
    type: "array",
    maxItems: 100,
    items: { $ref: "#/components/schemas/Product" },
  },
  next_cursor: { type: ["string", "null"] },
});
schema.CatalogueSnapshot = json(snapshotQuery);
schema.ExternalResolution = object({
  client_sale_id: id,
  payload_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
  resolution_id: id,
  resolved_at: { type: "string", format: "date-time" },
  reason,
  external_reference: { type: "string", minLength: 1, maxLength: 120 },
  canonical_sale_id: { type: ["string", "null"], format: "uuid" },
  canonical_receipt_no: { type: ["string", "null"] },
});
schema.CataloguePage = object({
  items: {
    type: "array",
    maxItems: 100,
    items: { $ref: "#/components/schemas/Product" },
  },
  cursor: { type: "string" },
  next_offset: { type: ["integer", "null"] },
  server_time: { type: "string", format: "date-time" },
  full_snapshot: { type: "boolean", const: true },
  covered_sale_ids: { type: "array", maxItems: 10000, items: id },
  covered_documents: {
    type: "array",
    maxItems: 10000,
    items: object({
      client_sale_id: id,
      payload_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    }),
  },
  resolved_documents: {
    type: "array",
    maxItems: 10000,
    items: { $ref: "#/components/schemas/ExternalResolution" },
  },
});
const detailLine = {
  ...schema.SaleLine,
  properties: { ...schema.SaleLine.properties, id },
  required: schema.SaleLine.required
    .filter((k: string) => k !== "line_id")
    .concat("id"),
  additionalProperties: true,
};
schema.SaleDetail = object(
  {
    id,
    receipt_no: { type: "string" },
    total_minor: money,
    lines: { type: "array", items: detailLine },
    payment: { $ref: "#/components/schemas/Payment" },
    refunds: { type: "array", items: { type: "object" } },
  },
  ["id", "receipt_no", "total_minor", "lines", "payment", "refunds"],
  true,
);
schema.RefundResult = object(
  {
    id,
    client_refund_id: id,
    original_sale_id: id,
    total_minor: money,
    posted_at: { type: "string", format: "date-time" },
  },
  ["id", "client_refund_id", "original_sale_id", "total_minor", "posted_at"],
  true,
);
schema.Shift = object(
  {
    id,
    device_id: id,
    opened_by: id,
    business_date: { type: "string", format: "date" },
    state: { type: "string", enum: ["OPEN", "CLOSED"] },
    opening_float_minor: money,
    expected_cash_minor: { type: "integer" },
    version: { type: "integer" },
  },
  [
    "id",
    "device_id",
    "opened_by",
    "business_date",
    "state",
    "opening_float_minor",
    "version",
  ],
  true,
);
schema.Bootstrap = object({
  demo: { type: "boolean" },
  store: { type: "object" },
  user: { type: "object" },
  devices: { type: "array", items: { type: "object" } },
  csrf_token: { type: "string" },
  server_time: { type: "string", format: "date-time" },
});
schema.LoginResult = object({
  user: { type: "object" },
  csrf_token: { type: "string" },
});
schema.CashMovement = object({
  client_event_id: id,
  amount_minor: {
    type: "integer",
    minimum: -1000000000,
    maximum: 1000000000,
    not: { const: 0 },
  },
  reason,
});
const response = (ref: string, status = "200") => ({
  [status]: {
    description: "Successful operation",
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/" + ref } },
    },
  },
});
function body(ref: string) {
  return {
    required: true,
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/" + ref } },
    },
  };
}
const paths = spec.paths;
paths["/inventory/receipts"].post.requestBody = body("StockReceipt");
paths["/inventory/adjustments"].post.requestBody = body("StockAdjustment");
paths["/shifts/{id}/count"].post.requestBody = body("ShiftCount");
paths["/shifts/{id}/close"].post.requestBody = body("ShiftClose");
if (paths["/sync/reconciliation"]) {
  paths["/shifts/{id}/reconcile"] = paths["/sync/reconciliation"];
  delete paths["/sync/reconciliation"];
}
paths["/shifts/{id}/reconcile"].post.requestBody = body("Reconciliation");
paths["/shifts/{id}/reconcile"].post.responses = response(
  "ReconciliationResult",
);
paths["/shifts/{id}/reconcile"].post.parameters = [
  { name: "id", in: "path", required: true, schema: id },
];
paths["/shifts/{id}/offline-permit"].post.requestBody = {
  content: { "application/json": { schema: object({}) } },
  required: true,
};
paths["/products"].get.responses = response("ProductsPage");
paths["/sync/catalogue"].get.responses = response("CataloguePage");
paths["/sales/{id}"].get.responses = response("SaleDetail");
paths["/sales"].get.responses = {
  "200": {
    description: "Bounded posted sales",
    content: {
      "application/json": {
        schema: {
          type: "array",
          maxItems: 100,
          items: { type: "object", additionalProperties: true },
        },
      },
    },
  },
};
paths["/shifts/current"].get.responses = {
  "200": {
    description: "Current shift or null",
    content: {
      "application/json": {
        schema: {
          oneOf: [{ $ref: "#/components/schemas/Shift" }, { type: "null" }],
        },
      },
    },
  },
};
for (const [path, item] of Object.entries(paths) as [
  string,
  Record<string, unknown>,
][])
  for (const op of Object.values(item) as Record<string, unknown>[])
    if (op && typeof op === "object" && op.operationId) {
      if (!path.includes("{")) continue;
      const existing = (op.parameters ?? []) as { name: string; in: string }[];
      op.parameters = [
        ...existing.filter((p) => p.in !== "path"),
        { name: "id", in: "path", required: true, schema: id },
      ];
    }
function operation(
  summary: string,
  method: string,
  requestSchema?: Record<string, unknown>,
  managerOnly = false,
) {
  return {
    [method]: {
      summary,
      description: managerOnly
        ? "Manager only; normal cookie/CSRF authorization."
        : summary,
      security: [
        { cookieAuth: [], ...(method === "get" ? {} : { csrfToken: [] }) },
      ],
      ...(requestSchema
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: requestSchema } },
            },
          }
        : {}),
      responses: {
        "200": {
          description: "Successful operation",
          content: {
            "application/json": {
              schema: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
  };
}
paths["/sync/catalogue"].post = operation(
  "Read a consistent catalogue/stock page and identify already-posted local sale IDs",
  "post",
  { $ref: "#/components/schemas/CatalogueSnapshot" },
).post;
paths["/sync/catalogue"].post.responses = response("CataloguePage");
for (const [name, value] of Object.entries({
  CreateUser: createUserCommand,
  UpdateUser: updateUserCommand,
  ResetPassword: resetPasswordCommand,
  ChangePassword: changePasswordCommand,
  RevokeSessions: revokeSessionsCommand,
}))
  schema[name] = json(value);
schema.User = object({
  id,
  email: { type: "string", format: "email" },
  display_name: { type: "string" },
  role: { type: "string", enum: ["MANAGER", "CASHIER"] },
  active: { type: "boolean" },
  version: { type: "integer", minimum: 1 },
  created_at: { type: "string", format: "date-time" },
});
paths["/users"] = {
  ...operation("List store operators", "get", undefined, true),
  ...operation(
    "Create store operator",
    "post",
    { $ref: "#/components/schemas/CreateUser" },
    true,
  ),
};
paths["/users"].get.responses = {
  "200": {
    description: "Store operators; credentials excluded",
    content: {
      "application/json": {
        schema: { type: "array", items: { $ref: "#/components/schemas/User" } },
      },
    },
  },
};
paths["/users"].post.responses = response("User", "201");
paths["/users/{id}"] = operation(
  "Change operator access with optimistic version; revoke old sessions",
  "patch",
  { $ref: "#/components/schemas/UpdateUser" },
  true,
);
paths["/users/{id}"].patch.parameters = [
  { name: "id", in: "path", required: true, schema: id },
];
paths["/users/{id}"].patch.responses = response("User");
paths["/users/{id}/password"] = operation(
  "Reset another operator's password and revoke sessions",
  "post",
  { $ref: "#/components/schemas/ResetPassword" },
  true,
);
paths["/users/{id}/password"].post.parameters = [
  { name: "id", in: "path", required: true, schema: id },
];
paths["/users/{id}/password"].post.responses = response("User");
for (const [path, ref] of [
  ["/auth/password", "ChangePassword"],
  ["/auth/revoke-sessions", "RevokeSessions"],
]) {
  paths[path] = operation(
    "Verify current password, revoke old sessions and return a replacement session",
    "post",
    { $ref: `#/components/schemas/${ref}` },
  );
  paths[path].post.responses = response("LoginResult");
}
paths["/devices/{id}"] = operation(
  "Permanently revoke terminal and offline permits; preserve existing documents",
  "patch",
  object({ revoked: { type: "boolean", const: true }, reason }),
  true,
);
paths["/devices/{id}"].patch.parameters = [
  { name: "id", in: "path", required: true, schema: id },
];
paths["/categories"].post = operation(
  "Create a category",
  "post",
  object({ name: { type: "string", minLength: 1, maxLength: 80 } }),
  true,
).post;
paths["/demo/login"] = operation(
  "Local synthetic demo session; unavailable in production",
  "post",
  object({ role: { type: "string", enum: ["MANAGER", "CASHIER"] } }),
);
paths["/demo/login"].post.security = [];
paths["/sync/register"] = operation(
  "Register a frozen online document before sync posting",
  "post",
  { $ref: "#/components/schemas/SaleCommand" },
);
paths["/sync/review"] = operation(
  "List preserved server recovery cases",
  "get",
  undefined,
  true,
);
paths["/sync/review"].get.responses = {
  "200": {
    description: "Bounded manager-only review cases",
    content: {
      "application/json": {
        schema: {
          type: "array",
          maxItems: 100,
          items: { type: "object", additionalProperties: true },
        },
      },
    },
  },
};
paths["/sync/review/{id}/resolve"] = operation(
  "Record external reconciliation without deleting or posting the quarantined document",
  "post",
  object({
    reason,
    external_reference: { type: "string", minLength: 1, maxLength: 120 },
  }),
  true,
);
paths["/sync/review/{id}/resolve"].post.parameters = [
  { name: "id", in: "path", required: true, schema: id },
];
paths["/audit"] = operation(
  "Read bounded audit events",
  "get",
  undefined,
  true,
);
paths["/audit"].get.responses = paths["/sync/review"].get.responses;
for (const path of ["/products", "/sales", "/inventory/ledger"]) {
  paths[path].get.parameters = [
    {
      name: "limit",
      in: "query",
      schema: { type: "integer", minimum: 1, maximum: 100 },
    },
    { name: "cursor", in: "query", schema: { type: "string", maxLength: 100 } },
  ];
}
paths["/sync/catalogue"].get.parameters = [
  {
    name: "offset",
    in: "query",
    schema: { type: "integer", minimum: 0, maximum: 100000 },
  },
  { name: "cursor", in: "query", schema: { type: "string", maxLength: 80 } },
];
await writeFile("specs/openapi.yaml", YAML.stringify(spec));
console.log(
  "OpenAPI aligned with implemented V1 inputs and response projections",
);

let references = 0;
function checkReferences(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref") {
      assert.ok(
        typeof child === "string" && child.startsWith("#/"),
        "Only local OpenAPI references are supported",
      );
      const target = child
        .slice(2)
        .split("/")
        .reduce(
          (node: unknown, part: string) =>
            (node as Record<string, unknown> | undefined)?.[
              part.replace(/~1/g, "/").replace(/~0/g, "~")
            ],
          spec,
        );
      assert.notEqual(target, undefined, "Unresolved OpenAPI reference");
      references++;
    } else checkReferences(child);
  }
}
checkReferences(spec);
assert.ok(
  saleCommand.safeParse(
    JSON.parse(await readFile("specs/example-sale.json", "utf8")),
  ).success,
);
await mkdir("docs/qa", { recursive: true });
await writeFile(
  "docs/qa/contract-results.json",
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      status: "PASS",
      paths: Object.keys(spec.paths).length,
      local_references: references,
      canonical_fixture: "Runtime command validation PASS",
      scope:
        "YAML parsing, local reference resolution and shared runtime schemas; full OpenAPI conformance certification NOT RUN",
    },
    null,
    2,
  ),
);
