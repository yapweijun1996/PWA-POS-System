import { expect, it } from "vitest";
import { externalResolution } from "../../apps/web/src/db.ts";
it("rejects recovery dispositions with contradictory canonical identity fields", () => {
  const resolution = {
    client_sale_id: crypto.randomUUID(),
    payload_sha256: "a".repeat(64),
    resolution_id: crypto.randomUUID(),
    resolved_at: "2026-10-03T00:00:00.000Z",
    reason: "Synthetic external reconciliation",
    external_reference: "TEST-001",
    canonical_sale_id: null,
    canonical_receipt_no: null,
  };
  expect(externalResolution.parse(resolution)).toEqual(resolution);
  expect(() =>
    externalResolution.parse({
      ...resolution,
      canonical_sale_id: crypto.randomUUID(),
    }),
  ).toThrow();
  expect(() =>
    externalResolution.parse({
      ...resolution,
      canonical_receipt_no: "TEST-RECEIPT",
    }),
  ).toThrow();
  expect(
    externalResolution.parse({
      ...resolution,
      canonical_sale_id: crypto.randomUUID(),
      canonical_receipt_no: "TEST-RECEIPT",
    }),
  ).toHaveProperty("canonical_receipt_no", "TEST-RECEIPT");
});
