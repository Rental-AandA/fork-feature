import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);
const stateLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-usage-sources-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

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
      stateLayer,
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

it("decodes money sources with their key defaults", () => {
  const settings = decodeServerSettings({
    usageLimitSources: {
      fal: { kind: "fal" },
      router: { kind: "openrouter", apiKey: "key" },
      jev: { kind: "typesafe", startCredit: 50 },
    },
  });
  expect(settings.usageLimitSources).toEqual({
    fal: { kind: "fal", apiKey: "", enabled: true },
    router: { kind: "openrouter", apiKey: "key", managementKey: "", enabled: true },
    jev: { kind: "typesafe", startCredit: 50, enabled: true },
  });
  expect(() =>
    decodeServerSettings({ usageLimitSources: { jev: { kind: "typesafe", startCredit: -1 } } }),
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
        message: "Canva shows AI credits only on its billing page.",
      },
      externalUsage: {
        label: "Canva billing",
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
      stateLayer,
    ]),
    Effect.scoped,
  ),
);

it.effect("derives DeepSeek spend across refreshes and explains sources without an API", () => {
  let balance = "10.00";
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    balance = "9.50";
    yield* sources.refresh;
    const byId = new Map(
      (yield* sources.current).map((snapshot) => [String(snapshot.id), snapshot]),
    );

    expect(byId.get("deepseek")?.accounts[0]?.usageLimits).toMatchObject({
      windows: [{ id: "balance-USD", remaining: 9.5, unit: "USD" }],
      spend: { currency: "USD", day: 0.5, month: 0.5 },
    });
    expect(byId.get("jev")).toMatchObject({ kind: "typesafe", label: "Jev" });
    expect(byId.get("jev")?.accounts[0]?.usageLimits).toMatchObject({
      windows: [],
      unavailable: {
        reason: "unsupported",
        message:
          "Jev usage is counted once winnow is connected. Starting credit: $50.00 since 2026-10-01.",
      },
      externalUsage: { url: "https://console.typesafe.ai" },
    });
    expect(byId.get("fal")).toMatchObject({
      kind: "fal",
      label: "fal",
      accounts: [],
      error: "No API key configured.",
    });
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("deepseek")]: {
            kind: "deepseek",
            apiKey: "deepseek-key",
            enabled: true,
          },
          [UsageLimitSourceId.make("jev")]: {
            kind: "typesafe",
            startCredit: 50,
            startDate: "2026-10-01",
            enabled: true,
          },
          [UsageLimitSourceId.make("fal")]: { kind: "fal", apiKey: "", enabled: true },
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
              Response.json({
                is_available: true,
                balance_infos: [{ currency: "USD", total_balance: balance }],
              }),
            ),
          ),
        ),
      ),
      NodeCrypto.layer,
      stateLayer,
    ]),
    Effect.scoped,
  );
});

const higgsfieldId = UsageLimitSourceId.make("higgsfield");

function higgsfieldHttp(onRefresh: (refreshToken: string) => Effect.Effect<void>) {
  return HttpClient.make((request) =>
    Effect.gen(function* () {
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      if (new URL(request.url).pathname === "/oauth/token") {
        const refreshToken = new URLSearchParams(body).get("refresh_token") ?? "";
        yield* onRefresh(refreshToken);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            access_token: "access",
            refresh_token: `${refreshToken}-rotated`,
            expires_in: 86_399,
          }),
        );
      }
      const message = JSON.parse(body) as { id?: number; params?: { name?: string } };
      if (message.id === undefined) {
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 202 }));
      }
      const text =
        message.params?.name === "balance"
          ? "Credits: 7 | Plan: plus"
          : JSON.stringify({ items: [], next_cursor: null });
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text }] },
        }),
      );
    }),
  );
}

const higgsfieldLayers = (http: HttpClient.HttpClient) =>
  Layer.mergeAll(
    ServerSettings.layerTest({
      usageLimitSources: {
        [higgsfieldId]: {
          kind: "higgsfield",
          clientId: "client-1",
          refreshToken: "refresh-1",
          enabled: true,
        },
      },
    }),
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
    Layer.succeed(HttpClient.HttpClient, http),
    NodeCrypto.layer,
    stateLayer,
  );

it.effect("saves Higgsfield's rotated refresh token and shows the credits", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const stored = (yield* settings.getSettings).usageLimitSources[higgsfieldId];
    expect(stored).toMatchObject({ kind: "higgsfield", refreshToken: "refresh-1-rotated" });
    const [snapshot] = yield* sources.current;
    expect(snapshot?.accounts[0]).toMatchObject({
      plan: "plus",
      usageLimits: { windows: [{ id: "credits", remaining: 7, unit: "credits" }] },
    });
  }).pipe(Effect.provide(higgsfieldLayers(higgsfieldHttp(() => Effect.void))), Effect.scoped),
);

it.effect("never overwrites a Higgsfield reconnect with a stale rotation", () => {
  let reconnect: Effect.Effect<void> = Effect.void;
  return Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    // The user finishes a new sign-in while the old token is being refreshed.
    reconnect = settings
      .updateSettings({
        usageLimitSources: {
          [higgsfieldId]: {
            kind: "higgsfield",
            clientId: "client-2",
            refreshToken: "refresh-new-login",
            enabled: true,
          },
        },
      })
      .pipe(Effect.orDie, Effect.asVoid);
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const stored = (yield* settings.getSettings).usageLimitSources[higgsfieldId];
    expect(stored?.kind === "higgsfield" && stored.refreshToken).toMatch(/^refresh-new-login/);
  }).pipe(
    Effect.provide(
      higgsfieldLayers(
        higgsfieldHttp((refreshToken) =>
          refreshToken === "refresh-1" ? Effect.suspend(() => reconnect) : Effect.void,
        ),
      ),
    ),
    Effect.scoped,
  );
});
