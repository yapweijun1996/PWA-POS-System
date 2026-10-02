import type {
  Bootstrap,
  Permit,
  Shift,
} from "../../../packages/contracts/index.ts";
import type { CartLine } from "./db.ts";

export type TrustedAnchor = { server: number; monotonic: number; wall: number };
export function offlineAllowed(input: {
  anchor: TrustedAnchor | null;
  permit: Permit | null;
  shift: Shift | null;
  boot: Bootstrap | null;
  cart: CartLine[];
  monotonic: number;
  wall: number;
}): boolean {
  const { anchor, permit, shift, boot, cart } = input;
  if (!anchor || !permit || !shift || !boot || shift.state !== "OPEN")
    return false;
  const elapsed = input.monotonic - anchor.monotonic,
    wall = input.wall - anchor.wall;
  const trustedTime = anchor.server + elapsed;
  if (
    !Number.isFinite(trustedTime) ||
    elapsed < 0 ||
    Math.abs(wall - elapsed) > 5000 ||
    !(
      trustedTime >= Date.parse(permit.issued_at) &&
      trustedTime < Date.parse(permit.expires_at)
    )
  )
    return false;
  const claims = permit.signed_claims as Permit["signed_claims"] & {
    user_id?: string;
    store_id?: string;
    device_id?: string;
    shift_id?: string;
  };
  if (
    !Array.isArray(claims.revisions) ||
    claims.discount_bps !== 0 ||
    !Number.isInteger(permit.max_sales) ||
    permit.max_sales < 1 ||
    permit.max_sales > 200
  )
    return false;
  return (
    shift.opened_by === boot.user.id &&
    claims.user_id === boot.user.id &&
    claims.store_id === boot.store.id &&
    claims.device_id === shift.device_id &&
    claims.shift_id === shift.id &&
    boot.devices.some((d) => d.id === shift.device_id && !d.revoked_at) &&
    cart.every(
      (line) =>
        line.discount_minor === 0 &&
        claims.revisions.includes(line.product.price_revision_id),
    )
  );
}
