import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HiggsfieldConnect from "./HiggsfieldConnect.ts";

const sourceId = UsageLimitSourceId.make("higgsfield");
const redirectUri = "http://127.0.0.1:3773/oauth/higgsfield/callback";

function clerkAnswering() {
  const requests: Array<{ path: string; body: string }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      requests.push({ path, body });
      return HttpClientResponse.fromWeb(
        request,
        path === "/oauth/register"
          ? Response.json({ client_id: "client-new" })
          : Response.json({
              access_token: "access",
              refresh_token: "refresh-1",
              expires_in: 86399,
            }),
      );
    }),
  );
  return { requests, http };
}

const layer = (
  http: HttpClient.HttpClient,
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) =>
  HiggsfieldConnect.layer.pipe(
    Layer.provideMerge(ServerSettings.layerTest(settings)),
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          return { ...(yield* ServerConfig.ServerConfig), port: 3773 };
        }),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-higgsfield-connect-" })),
      ),
    ),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(NodeServices.layer),
  );

const stateOf = (authorizeUrl: string) => new URL(authorizeUrl).searchParams.get("state") ?? "";

describe("Higgsfield connect", () => {
  it.effect("registers a client and builds a complete PKCE authorize URL", () => {
    const { http, requests } = clerkAnswering();
    return Effect.gen(function* () {
      const connect = yield* HiggsfieldConnect.HiggsfieldConnect;
      const { authorizeUrl } = yield* connect.start({ sourceId, label: "Studio" });
      const url = new URL(authorizeUrl);
      expect(`${url.origin}${url.pathname}`).toBe("https://clerk.higgsfield.ai/oauth/authorize");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        response_type: "code",
        client_id: "client-new",
        redirect_uri: redirectUri,
        scope: "openid email offline_access",
        state: expect.stringMatching(/^[\w-]{20,}$/),
        code_challenge: expect.stringMatching(/^[\w-]{43}$/),
        code_challenge_method: "S256",
        resource: "https://mcp.higgsfield.ai/mcp",
      });
      expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      });
      // The source exists before sign-in finishes, so an abandoned sign-in stays visible.
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      expect(settings.usageLimitSources[sourceId]).toMatchObject({
        kind: "higgsfield",
        label: "Studio",
        refreshToken: "",
      });
    }).pipe(Effect.provide(layer(http)));
  });

  it.effect("stores the sign-in only for the state it issued, once", () => {
    const { http, requests } = clerkAnswering();
    return Effect.gen(function* () {
      const connect = yield* HiggsfieldConnect.HiggsfieldConnect;
      const { authorizeUrl } = yield* connect.start({ sourceId });
      const wrong = yield* Effect.flip(connect.complete({ state: "forged", code: "code-1" }));
      expect(wrong.detail).toContain("expired or was already used");

      yield* connect.complete({ state: stateOf(authorizeUrl), code: "code-1" });
      const exchange = new URLSearchParams(requests.at(-1)?.body);
      expect(exchange.get("grant_type")).toBe("authorization_code");
      expect(exchange.get("code_verifier")).toMatch(/^[\w-]{43}$/);
      expect(exchange.get("redirect_uri")).toBe(redirectUri);
      const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
      expect(settings.usageLimitSources[sourceId]).toMatchObject({
        clientId: "client-new",
        clientRedirectUri: redirectUri,
        refreshToken: "refresh-1",
      });

      const replay = yield* Effect.flip(
        connect.complete({ state: stateOf(authorizeUrl), code: "code-1" }),
      );
      expect(replay.detail).toContain("expired or was already used");
    }).pipe(Effect.provide(layer(http)));
  });

  it.effect("rejects a sign-in finished after ten minutes", () => {
    const { http } = clerkAnswering();
    return Effect.gen(function* () {
      const connect = yield* HiggsfieldConnect.HiggsfieldConnect;
      const { authorizeUrl } = yield* connect.start({ sourceId });
      yield* TestClock.adjust("10 minutes");
      const expired = yield* Effect.flip(
        connect.complete({ state: stateOf(authorizeUrl), code: "code-1" }),
      );
      expect(expired.detail).toContain("expired");
    }).pipe(Effect.provide(layer(http)));
  });

  it.effect(
    "reuses a client registered for this redirect and keeps the old sign-in until done",
    () => {
      const { http, requests } = clerkAnswering();
      return Effect.gen(function* () {
        const connect = yield* HiggsfieldConnect.HiggsfieldConnect;
        const { authorizeUrl } = yield* connect.start({ sourceId });
        expect(new URL(authorizeUrl).searchParams.get("client_id")).toBe("client-old");
        expect(requests).toEqual([]);
        const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
        expect(settings.usageLimitSources[sourceId]).toMatchObject({ refreshToken: "refresh-old" });
      }).pipe(
        Effect.provide(
          layer(http, {
            usageLimitSources: {
              [sourceId]: {
                kind: "higgsfield",
                clientId: "client-old",
                clientRedirectUri: redirectUri,
                refreshToken: "refresh-old",
                enabled: true,
              },
            },
          }),
        ),
      );
    },
  );
});
