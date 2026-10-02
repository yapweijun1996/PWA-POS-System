import { api, ApiError } from "./api.ts";
import { db, meta, putMeta } from "./db.ts";

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

export async function savedCommands(): Promise<SavedCommand[]> {
  const commands = await Promise.all(
    commandKeys.map(async (key) => {
      const value = await meta<Omit<SavedCommand, "key">>(key);
      return value ? { ...value, key } : null;
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
    await db.meta.delete(command.key);
  } catch (error) {
    // Authentication failures and uncertain network results keep the original identity.
    if (
      error instanceof ApiError &&
      [404, 409, 422].includes(error.status) &&
      error.code !== "IDEMPOTENCY_CONFLICT"
    )
      await db.meta.delete(command.key);
    throw error;
  }
}
export async function saveAndSend(command: SavedCommand) {
  await requireNoSavedCommands();
  await putMeta(command.key, command);
  await sendSavedCommand(command, command.actor_id);
}
