import { describe, expect, it } from "vitest";
import { validateSavedCommand } from "../../apps/web/src/commands.ts";
describe("saved administrative request validation", () => {
  const command = {
    key: "cash_command",
    actor_id: crypto.randomUUID(),
    path: `/shifts/${crypto.randomUUID()}/cash-movements`,
    body: {
      client_event_id: crypto.randomUUID(),
      amount_minor: -500,
      reason: "Test cash out",
    },
  };
  it("preserves a stable cash-out request and identity", () =>
    expect(validateSavedCommand(command)).toEqual(command));
  it("rejects arbitrary routes, identity-less actors and malformed financial bodies", () => {
    for (const change of [
      { path: "https://example.invalid/exfiltrate" },
      { path: "/auth/password" },
      { actor_id: "" },
      { body: { ...command.body, amount_minor: 0 } },
      { body: { ...command.body, injected_field: "extra" } },
    ])
      expect(() => validateSavedCommand({ ...command, ...change })).toThrow();
  });
});
