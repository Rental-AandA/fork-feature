import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  ServerConfigStreamEvent,
  ServerSettings as ServerSettingsSchema,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettingsSchema);

it("keeps decoding cliproxy sources saved before source kinds existed", () => {
  const settings = decodeServerSettings({
    usageLimitSources: {
      hub: { kind: "cliproxy", url: "https://hub.test:8317", managementKey: "" },
      named: { kind: "cliproxy", label: "Named", url: "https://named.test", enabled: false },
    },
  });
  expect(settings.usageLimitSources).toEqual({
    hub: { kind: "cliproxy", url: "https://hub.test:8317", managementKey: "", enabled: true },
    named: {
      kind: "cliproxy",
      label: "Named",
      url: "https://named.test",
      managementKey: "",
      enabled: false,
    },
  });
});

it("defaults the ElevenLabs API URL and rejects a source kind this build does not know", () => {
  const settings = decodeServerSettings({
    usageLimitSources: { voice: { kind: "elevenlabs", apiKey: "" } },
  });
  expect(settings.usageLimitSources[UsageLimitSourceId.make("voice")]).toEqual({
    kind: "elevenlabs",
    apiKey: "",
    baseUrl: "https://api.elevenlabs.io",
    enabled: true,
  });
  expect(() =>
    decodeServerSettings({ usageLimitSources: { other: { kind: "unknown", url: "x" } } }),
  ).toThrow();
});

it.effect("reads mixed source kinds and keeps each failure on its own source", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    const byId = new Map(snapshots.map((snapshot) => [String(snapshot.id), snapshot]));

    expect(byId.get("hub")).toMatchObject({
      kind: "cliproxy",
      accounts: [],
      error: "No management key configured.",
    });
    expect(byId.get("voice")).toMatchObject({ kind: "elevenlabs", label: "ElevenLabs" });
    expect(byId.get("voice")?.error).toBeUndefined();
    expect(byId.get("voice")?.accounts[0]?.usageLimits.windows[0]).toMatchObject({
      id: "characters",
      usedPercent: 10,
      remaining: 900,
      limit: 1000,
      unit: "characters",
    });
    expect(byId.get("rejected")).toMatchObject({
      kind: "elevenlabs",
      label: "Second voice",
      accounts: [],
      error: "ElevenLabs answered with HTTP 401.",
    });
    expect(byId.get("design")).toMatchObject({ kind: "canva", label: "Canva" });
    expect(byId.get("design")?.accounts[0]?.usageLimits).toMatchObject({
      windows: [],
      unavailable: {
        reason: "unsupported",
        message: "Canva zeigt KI-Credits nur in der Abrechnung",
      },
      externalUsage: {
        label: "Canva-Abrechnung",
        url: "https://www.canva.com/settings/billing-and-plans",
      },
    });
    expect(byId.has("disabled")).toBe(false);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();

    const redeem = yield* Effect.flip(
      sources.consumeResetCredit({
        sourceId: UsageLimitSourceId.make("voice"),
        accountId: "ElevenLabs",
        creditId: "credit",
      }),
    );
    expect(redeem.detail).toBe("The usage limit source is missing or disabled.");
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("voice")]: {
            kind: "elevenlabs",
            apiKey: "good-key",
            baseUrl: "https://elevenlabs.test",
            enabled: true,
          },
          [UsageLimitSourceId.make("rejected")]: {
            kind: "elevenlabs",
            label: "Second voice",
            apiKey: "bad-key",
            baseUrl: "https://elevenlabs.test",
            enabled: true,
          },
          [UsageLimitSourceId.make("design")]: { kind: "canva", enabled: true },
          [UsageLimitSourceId.make("disabled")]: { kind: "canva", enabled: false },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() =>
            HttpClientResponse.fromWeb(
              request,
              request.headers["xi-api-key"] === "good-key"
                ? Response.json({ tier: "starter", character_count: 100, character_limit: 1000 })
                : Response.json({ detail: "invalid_api_key" }, { status: 401 }),
            ),
          ),
        ),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);
