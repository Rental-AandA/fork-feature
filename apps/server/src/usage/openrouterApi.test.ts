import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeOpenRouterApi } from "./openrouterApi.ts";

const config = {
  kind: "openrouter",
  apiKey: "inference-secret",
  managementKey: "",
  enabled: true,
} as const;

function openrouterAnswering(answer: (path: string) => { status?: number; body: unknown }) {
  const requests: Array<{ path: string; auth: string | undefined }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      requests.push({ path, auth: request.headers.authorization });
      const { status = 200, body } = answer(path);
      return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
    }),
  );
  return {
    requests,
    api: makeOpenRouterApi.pipe(Effect.provideService(HttpClient.HttpClient, http)),
  };
}

const keyInfo = {
  data: {
    label: "sk-or-v1-abc",
    limit: null,
    limit_remaining: null,
    usage: 25.75,
    usage_daily: 0.8,
    usage_weekly: 3.2,
    usage_monthly: 7.1,
  },
};

describe("OpenRouter balance and spend", () => {
  it.effect("reports the key's spend without a management key", () =>
    Effect.gen(function* () {
      const { api, requests } = openrouterAnswering(() => ({ body: keyInfo }));
      const [account] = yield* (yield* api).readAccounts(config);
      expect(requests).toEqual([{ path: "/api/v1/key", auth: "Bearer inference-secret" }]);
      expect(account).toMatchObject({ id: "OpenRouter", driver: "openrouter" });
      expect(account?.usageLimits.windows).toEqual([]);
      expect(account?.usageLimits.spend).toEqual({
        currency: "USD",
        day: 0.8,
        week: 3.2,
        month: 7.1,
      });
    }),
  );

  it.effect("adds the account balance and the key limit when both are known", () =>
    Effect.gen(function* () {
      const { api, requests } = openrouterAnswering((path) =>
        path.endsWith("/credits")
          ? { body: { data: { total_credits: 100.5, total_usage: 25.75 } } }
          : { body: { data: { ...keyInfo.data, limit: 20, limit_remaining: 15 } } },
      );
      const [account] = yield* (yield* api).readAccounts({
        ...config,
        managementKey: "management-secret",
      });
      expect(requests).toContainEqual({
        path: "/api/v1/credits",
        auth: "Bearer management-secret",
      });
      expect(account?.usageLimits.windows).toEqual([
        {
          id: "credits",
          kind: "other",
          label: "Credits",
          usedPercent: (25.75 / 100.5) * 100,
          remaining: 74.75,
          limit: 100.5,
          unit: "USD",
        },
        {
          id: "key-limit",
          kind: "other",
          label: "Key limit",
          usedPercent: 25,
          remaining: 15,
          limit: 20,
          unit: "USD",
        },
      ]);
    }),
  );

  it.effect("omits spend OpenRouter does not report", () =>
    Effect.gen(function* () {
      const { api } = openrouterAnswering(() => ({ body: { data: { limit: null } } }));
      const [account] = yield* (yield* api).readAccounts(config);
      expect(account?.usageLimits).not.toHaveProperty("spend");
    }),
  );

  it.effect("keeps the key's spend and warns when the management key is refused", () =>
    Effect.gen(function* () {
      const refusedManagement = openrouterAnswering((path) =>
        path.endsWith("/credits") ? { status: 403, body: {} } : { body: keyInfo },
      );
      const [account] = yield* (yield* refusedManagement.api).readAccounts({
        ...config,
        managementKey: "wrong",
      });
      expect(account?.usageLimits.spend).toMatchObject({ currency: "USD", month: 7.1 });
      expect(account?.usageLimits.notice).toBe(
        "Account balance unavailable: OpenRouter refused the management key (HTTP 403).",
      );

      const refusedKey = openrouterAnswering(() => ({ status: 401, body: {} }));
      const key = yield* Effect.flip((yield* refusedKey.api).readAccounts(config));
      expect(key.detail).toBe("OpenRouter answered with HTTP 401.");
    }),
  );
});
