import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeElevenLabsApi } from "./elevenlabsApi.ts";

const config = {
  kind: "elevenlabs",
  apiKey: "elevenlabs-secret",
  baseUrl: "https://elevenlabs.test",
  enabled: true,
} as const;

function apiAnswering(status: number, body: unknown) {
  const requests: Array<{ url: string; key: string | undefined }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, key: request.headers["xi-api-key"] });
      return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
    }),
  );
  return {
    requests,
    api: makeElevenLabsApi.pipe(Effect.provideService(HttpClient.HttpClient, http)),
  };
}

const subscription = {
  tier: "creator",
  character_count: 25_000,
  character_limit: 100_000,
  next_character_count_reset_unix: 4070908800,
};

describe("ElevenLabs subscription usage", () => {
  it.effect("reports the monthly character window with its absolute allowance", () =>
    Effect.gen(function* () {
      const { api, requests } = apiAnswering(200, subscription);
      const [account, ...rest] = yield* (yield* api).readAccounts(config);
      expect(rest).toEqual([]);
      expect(requests).toEqual([
        { url: "https://elevenlabs.test/v1/user/subscription", key: "elevenlabs-secret" },
      ]);
      expect(account).toMatchObject({ driver: "elevenlabs", plan: "creator" });
      expect(account?.usageLimits.unavailable).toBeUndefined();
      expect(account?.usageLimits.windows).toEqual([
        {
          id: "characters",
          kind: "monthly",
          label: "Characters",
          usedPercent: 25,
          remaining: 75_000,
          limit: 100_000,
          unit: "characters",
          resetsAt: "2099-01-01T00:00:00.000Z",
        },
      ]);
    }),
  );

  it.effect("omits the reset when ElevenLabs reports none", () =>
    Effect.gen(function* () {
      const { api } = apiAnswering(200, { ...subscription, next_character_count_reset_unix: null });
      const [account] = yield* (yield* api).readAccounts(config);
      expect(account?.usageLimits.windows[0]).not.toHaveProperty("resetsAt");
      expect(account?.usageLimits.windows[0]?.usedPercent).toBe(25);
    }),
  );

  it.effect("caps an overdrawn allowance at fully used with nothing remaining", () =>
    Effect.gen(function* () {
      const { api } = apiAnswering(200, { ...subscription, character_count: 120_000 });
      const [account] = yield* (yield* api).readAccounts(config);
      expect(account?.usageLimits.windows[0]).toMatchObject({ usedPercent: 100, remaining: 0 });
    }),
  );

  it.effect("marks a zero character limit as a failed probe instead of dividing by zero", () =>
    Effect.gen(function* () {
      const { api } = apiAnswering(200, { ...subscription, character_limit: 0 });
      const [account] = yield* (yield* api).readAccounts(config);
      expect(account?.usageLimits.windows).toEqual([]);
      expect(account?.usageLimits.unavailable?.reason).toBe("probeFailed");
    }),
  );

  it.effect("names the status, not the body or key, when ElevenLabs rejects the key", () =>
    Effect.gen(function* () {
      const { api } = apiAnswering(401, {
        detail: { status: "invalid_api_key", message: "elevenlabs-secret is invalid" },
      });
      const error = yield* Effect.flip((yield* api).readAccounts(config));
      expect(error.detail).toBe("ElevenLabs answered with HTTP 401.");
      expect(error.detail).not.toContain("elevenlabs-secret");
    }),
  );

  it.effect("says when ElevenLabs does not answer in time", () =>
    Effect.gen(function* () {
      const api = yield* makeElevenLabsApi.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.never),
        ),
      );
      const pending = yield* Effect.flip(api.readAccounts(config)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("15 seconds");
      const error = yield* Fiber.join(pending);
      expect(error.detail).toBe("ElevenLabs did not answer within 15 seconds.");
    }),
  );
});
