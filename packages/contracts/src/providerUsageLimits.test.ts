import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  UsageLimitSourceSnapshots,
} from "./providerUsageLimits.ts";

const decodeWindow = Schema.decodeUnknownSync(ServerProviderUsageWindow);
const decodeSnapshots = Schema.decodeUnknownSync(UsageLimitSourceSnapshots);
const decodeLimits = Schema.decodeUnknownSync(ServerProviderUsageLimits);

const window = { id: "characters", kind: "monthly", label: "Characters", usedPercent: 25 };

describe("ServerProviderUsageWindow absolute allowance", () => {
  it("keeps windows without an allowance valid", () => {
    expect(decodeWindow(window)).toEqual(window);
  });

  it("decodes remaining, limit and unit", () => {
    const withAmount = { ...window, remaining: 75_000, limit: 100_000, unit: " characters " };
    expect(decodeWindow(withAmount)).toEqual({ ...withAmount, unit: "characters" });
    expect(decodeWindow({ ...window, remaining: 0, limit: 0, unit: "credits" })).toMatchObject({
      remaining: 0,
      limit: 0,
    });
  });

  it.each([{ remaining: -1 }, { limit: -0.5 }, { remaining: "10" }, { unit: "" }, { unit: "   " }])(
    "rejects an invalid allowance %o",
    (invalid) => {
      expect(() => decodeWindow({ ...window, ...invalid })).toThrow();
    },
  );
});

describe("UsageLimitSourceSnapshots kinds", () => {
  const snapshot = (kind: string) => ({
    id: kind,
    kind,
    label: kind,
    checkedAt: "2026-10-20T00:00:00.000Z",
    accounts: [],
  });

  it("keeps known source kinds and drops kinds a newer server added", () => {
    const kinds = ["cliproxy", "elevenlabs", "canva", "fal", "deepseek", "openrouter", "typesafe"];
    const decoded = decodeSnapshots([...kinds, "future"].map((kind) => snapshot(kind)));
    expect(decoded.map((source) => source.kind)).toEqual(kinds);
  });
});

describe("ServerProviderUsageLimits spend", () => {
  const limits = { checkedAt: "2026-10-20T00:00:00.000Z", windows: [] };

  it("decodes partial spend and keeps reports without it valid", () => {
    expect(decodeLimits(limits)).toEqual(limits);
    expect(decodeLimits({ ...limits, spend: { currency: "USD", day: 0.8 } }).spend).toEqual({
      currency: "USD",
      day: 0.8,
    });
  });

  it.each([{ day: -1 }, { month: "7.10" }, { currency: "" }])("rejects spend %o", (invalid) => {
    expect(() => decodeLimits({ ...limits, spend: { currency: "USD", ...invalid } })).toThrow();
  });
});
