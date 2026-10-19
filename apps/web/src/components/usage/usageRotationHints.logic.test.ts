import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UsageRotationSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { rotationHints } from "./usageRotationHints.logic";

const NOW_MS = Date.parse("2026-10-20T12:00:00.000Z");
const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const id = (value: string) => ProviderInstanceId.make(value);

const provider = (
  instanceId: string,
  options: { driver?: ProviderDriverKind; usedPercent?: number; enabled?: boolean } = {},
): ServerProvider => ({
  instanceId: id(instanceId),
  driver: options.driver ?? codex,
  enabled: options.enabled ?? true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-20T12:00:00.000Z",
  models: [{ slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: "2026-10-20T12:00:00.000Z",
    windows: [
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: options.usedPercent ?? 10,
        resetsAt: "2026-10-25T00:00:00.000Z",
      },
    ],
  },
});

const on = (order: ReadonlyArray<string>): UsageRotationSettings => ({
  [codex]: { enabled: true, strategy: "order", order: order.map(id) },
});

const hints = (
  providers: ReadonlyArray<ServerProvider>,
  rotation: UsageRotationSettings,
  threadInstanceId: string | null = null,
) =>
  rotationHints({
    providers,
    rotation,
    threadInstanceId: threadInstanceId === null ? null : id(threadInstanceId),
    nowMs: NOW_MS,
  });

describe("rotation hints", () => {
  const threeCodex = [provider("codex"), provider("codex_2"), provider("codex_3")];

  it("points out rotation that is off only where a family has several enabled accounts", () => {
    const result = hints([...threeCodex, provider("claudeAgent", { driver: claude })], {});
    expect(result.get(codex)).toEqual({ kind: "off" });
    expect(result.has(claude)).toBe(false);

    const oneEnabled = hints([provider("codex"), provider("codex_2", { enabled: false })], {});
    expect(oneEnabled.size).toBe(0);
  });

  it("names the account rotation moves to, leaving out the thread's own account", () => {
    const rotation = on(["codex", "codex_2", "codex_3"]);
    expect(hints(threeCodex, rotation).get(codex)).toEqual({ kind: "next", accountName: "Codex" });
    expect(hints(threeCodex, rotation, "codex").get(codex)).toEqual({
      kind: "next",
      accountName: "Codex 2",
    });
  });

  it("skips limited accounts and says when no ticked account is free", () => {
    const providers = [provider("codex"), provider("codex_2", { usedPercent: 100 })];
    expect(hints(providers, on(["codex", "codex_2"]), "codex").get(codex)).toEqual({
      kind: "noneFree",
    });
    expect(hints(providers, on([])).get(codex)).toEqual({ kind: "noneTicked" });
  });
});
