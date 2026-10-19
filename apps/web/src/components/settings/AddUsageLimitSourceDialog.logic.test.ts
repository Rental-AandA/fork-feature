import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_USAGE_SOURCE_DRAFT,
  usageSourceConfig,
  usageSourceId,
} from "./AddUsageLimitSourceDialog.logic";

describe("usageSourceId", () => {
  it("never replaces an existing source of the same kind", () => {
    const draft = { kind: "elevenlabs", label: "", url: "" } as const;
    expect(usageSourceId(draft, new Set())).toBe("elevenlabs");
    expect(usageSourceId(draft, new Set(["elevenlabs"]))).toBe("elevenlabs-2");
    expect(usageSourceId(draft, new Set(["elevenlabs", "elevenlabs-2"]))).toBe("elevenlabs-3");
    expect(usageSourceId({ ...draft, kind: "canva" }, new Set(["canva"]))).toBe("canva-2");
    expect(usageSourceId({ ...draft, label: "Team" }, new Set(["elevenlabs-team"]))).toBe(
      "elevenlabs-team-2",
    );
  });

  it("keeps one id per hub URL so re-adding a hub updates it", () => {
    const hub = { kind: "cliproxy", label: "", url: "https://hub.test:8318/x" } as const;
    expect(usageSourceId(hub, new Set(["cliproxy-hub.test-8318"]))).toBe("cliproxy-hub.test-8318");
  });
});

describe("usageSourceConfig", () => {
  const draft = (overrides: Partial<typeof EMPTY_USAGE_SOURCE_DRAFT>) => ({
    ...EMPTY_USAGE_SOURCE_DRAFT,
    ...overrides,
  });

  it("requires the API key of money sources and keeps OpenRouter's management key optional", () => {
    expect(usageSourceConfig(draft({ kind: "fal" }))).toBeNull();
    expect(usageSourceConfig(draft({ kind: "deepseek", key: " sk " }))).toEqual({
      kind: "deepseek",
      apiKey: "sk",
      enabled: true,
    });
    expect(usageSourceConfig(draft({ kind: "openrouter", key: "sk", label: "Work" }))).toEqual({
      kind: "openrouter",
      label: "Work",
      apiKey: "sk",
      managementKey: "",
      enabled: true,
    });
  });

  it("accepts Jev without a starting credit and rejects one that is not an amount", () => {
    expect(usageSourceConfig(draft({ kind: "typesafe" }))).toEqual({
      kind: "typesafe",
      enabled: true,
    });
    expect(
      usageSourceConfig(draft({ kind: "typesafe", startCredit: "50", startDate: "2026-10-01" })),
    ).toEqual({ kind: "typesafe", startCredit: 50, startDate: "2026-10-01", enabled: true });
    expect(usageSourceConfig(draft({ kind: "typesafe", startCredit: "-5" }))).toBeNull();
    expect(usageSourceConfig(draft({ kind: "typesafe", startCredit: "ten" }))).toBeNull();
  });

  it("lets Higgsfield connect without a key, leaving credentials to the sign-in", () => {
    expect(usageSourceConfig(draft({ kind: "higgsfield", label: "Studio" }))).toEqual({
      kind: "higgsfield",
      label: "Studio",
      clientId: "",
      refreshToken: "",
      enabled: true,
    });
  });
});
