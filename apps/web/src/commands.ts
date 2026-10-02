import { api, ApiError } from "./api.ts";
import { z } from "zod";
import { refundCommand } from "../../../packages/contracts/index.ts";
import { canonical } from "../../../packages/domain/money.ts";
import { db, meta, putMeta, assertWriter } from "./db.ts";

export const commandKeys = [
  "stock_command",
  "refund_command",
  "cash_command",
] as const;
export type CommandKey = (typeof commandKeys)[number];
export type SavedCommand = {
  key: CommandKey;
  actor_id: string;
  path: string;
  body: Record<string, unknown>;
};
const id = z.string().uuid();
const reason = z.string().trim().min(1).max(500);
const stockReceipt = z
  .object({
    client_event_id: id,
    product_id: id,
    quantity: z.number().int().min(1).max(999999),
    reason,
  })
  .strict();
const stockCount = z
  .object({
    client_event_id: id,
    product_id: id,
    counted_quantity: z.number().int().min(0).max(999999),
    expected_version: z.number().int().positive(),
    reason,
  })
  .strict();
const cashMovement = z
  .object({
    client_event_id: id,
    amount_minor: z
      .number()
      .int()
      .min(-1e9)
      .max(1e9)
      .refine((n) => n !== 0),
    reason,
  })
  .strict();
export function validateSavedCommand(value: unknown): SavedCommand {
  const command = z
    .object({
      key: z.enum(commandKeys),
      actor_id: id,
      path: z.string(),
      body: z.record(z.string(), z.unknown()),
    })
    .strict()
    .parse(value);
  if (command.key === "stock_command") {
    if (command.path === "/inventory/receipts")
      stockReceipt.parse(command.body);
    else if (command.path === "/inventory/adjustments")
      stockCount.parse(command.body);
    else throw new Error("Invalid saved stock request path");
  } else if (command.key === "refund_command") {
    if (command.path !== "/refunds")
      throw new Error("Invalid saved refund request path");
    refundCommand.parse(command.body);
  } else {
    const match = /^\/shifts\/([^/]+)\/cash-movements$/.exec(command.path);
    if (!match) throw new Error("Invalid saved cash request path");
    id.parse(match[1]);
    cashMovement.parse(command.body);
  }
  return command;
}

export async function savedCommands(): Promise<SavedCommand[]> {
  const commands = await Promise.all(
    commandKeys.map(async (key) => {
      const value = await meta<Omit<SavedCommand, "key">>(key);
      return value ? validateSavedCommand({ ...value, key }) : null;
    }),
  );
  return commands.filter((value): value is SavedCommand => value !== null);
}
export async function requireNoSavedCommands() {
  if ((await savedCommands()).length)
    throw new Error(
      "A saved request needs confirmation. Open Sync center and retry it before recording another change or closing the shift.",
    );
}
export async function sendSavedCommand(command: SavedCommand, actorId: string) {
  command = validateSavedCommand(command);
  await assertWriter();
  if (command.actor_id !== actorId)
    throw new Error(
      "Sign in as the original operator to retry this saved request.",
    );
  try {
    await api(
      command.path,
      command.body,
      command.key === "refund_command"
        ? { "Idempotency-Key": String(command.body.client_refund_id) }
        : {},
    );
    await db.transaction("rw", db.meta, async () => {
      await assertWriter();
      const current = await meta<SavedCommand>(command.key);
      if (current && canonical(current) !== canonical(command))
        throw new Error(
          "The saved request changed while confirmation was pending",
        );
      await db.meta.delete(command.key);
    });
  } catch (error) {
    // Authentication failures and uncertain network results keep the original identity.
    if (
      error instanceof ApiError &&
      [404, 409, 422].includes(error.status) &&
      error.code !== "IDEMPOTENCY_CONFLICT"
    )
      await db.transaction("rw", db.meta, async () => {
        await assertWriter();
        const current = await meta<SavedCommand>(command.key);
        if (current && canonical(current) === canonical(command))
          await db.meta.delete(command.key);
      });
    throw error;
  }
}
export async function saveAndSend(command: SavedCommand) {
  command = validateSavedCommand(command);
  await db.transaction("rw", db.meta, async () => {
    await assertWriter();
    await requireNoSavedCommands();
    await putMeta(command.key, command);
  });
  await sendSavedCommand(command, command.actor_id);
}
