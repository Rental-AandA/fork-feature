import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_ROTATION,
  rotationFamilies,
  withAccountIncluded,
  withAccountMoved,
} from "./UsageRotationSettings.logic";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const id = (value: string) => ProviderInstanceId.make(value);

const provider = (instanceId: string, driver = codex): ServerProvider => ({
  instanceId: id(instanceId),
  driver,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-20T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

describe("usage rotation settings", () => {
  it("offers rotation only for drivers with several accounts, listed accounts first", () => {
    const families = rotationFamilies(
      [provider("codex-1"), provider("codex-2"), provider("codex-3"), provider("claude", claude)],
      { [codex]: { enabled: true, strategy: "order", order: [id("codex-3"), id("codex-1")] } },
    );
    expect(families).toHaveLength(1);
    expect(
      families[0]!.accounts.map(({ provider, included }) => [provider.instanceId, included]),
    ).toEqual([
      ["codex-3", true],
      ["codex-1", true],
      ["codex-2", false],
    ]);
    expect(rotationFamilies([provider("a"), provider("b")], {})[0]!.settings).toEqual(
      DEFAULT_ROTATION,
    );
  });

  it("adds, removes and reorders accounts without duplicates", () => {
    const settings = { enabled: true, strategy: "order" as const, order: [id("a"), id("b")] };
    expect(withAccountIncluded(settings, id("c"), true).order).toEqual(["a", "b", "c"]);
    expect(withAccountIncluded(settings, id("a"), true).order).toEqual(["b", "a"]);
    expect(withAccountIncluded(settings, id("a"), false).order).toEqual(["b"]);
    expect(withAccountMoved(settings, id("b"), -1).order).toEqual(["b", "a"]);
    expect(withAccountMoved(settings, id("a"), -1)).toBe(settings);
    expect(withAccountMoved(settings, id("c"), 1)).toBe(settings);
  });
});
