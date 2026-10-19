import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeDeepSeekApi } from "./deepseekApi.ts";

const config = { kind: "deepseek", apiKey: "deepseek-secret", enabled: true } as const;

function deepseekAnswering(status: number, body: unknown) {
  const requests: Array<{ url: string; auth: string | undefined }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, auth: request.headers.authorization });
      return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
    }),
  );
  return {
    requests,
    api: makeDeepSeekApi.pipe(Effect.provideService(HttpClient.HttpClient, http)),
  };
}

const recorded: Array<readonly [string, number]> = [];
const recordBalance = (currency: string, balance: number) =>
  Effect.sync(() => {
    recorded.push([currency, balance]);
    return currency === "USD" ? { day: 0.1, month: 0.5 } : { day: 1.25, month: 4 };
  });

describe("DeepSeek balance", () => {
  it.effect("parses string amounts into one window per currency with its own spend", () =>
    Effect.gen(function* () {
      recorded.length = 0;
      const { api, requests } = deepseekAnswering(200, {
        is_available: true,
        balance_infos: [
          { currency: "CNY", total_balance: "110.00", granted_balance: "10.00" },
          { currency: "USD", total_balance: " 2.5 " },
        ],
      });
      const [account] = yield* (yield* api).readAccounts(config, recordBalance);
      expect(requests).toEqual([
        { url: "https://api.deepseek.com/user/balance", auth: "Bearer deepseek-secret" },
      ]);
      expect(recorded).toEqual([
        ["CNY", 110],
        ["USD", 2.5],
      ]);
      expect(account).toMatchObject({ id: "DeepSeek", driver: "deepseek" });
      expect(account?.usageLimits.windows).toEqual([
        {
          id: "balance-CNY",
          kind: "other",
          label: "Balance (CNY)",
          usedPercent: 0,
          remaining: 110,
          unit: "CNY",
          spend: { day: 1.25, month: 4 },
        },
        {
          id: "balance-USD",
          kind: "other",
          label: "Balance (USD)",
          usedPercent: 0,
          remaining: 2.5,
          unit: "USD",
          spend: { day: 0.1, month: 0.5 },
        },
      ]);
      // Older clients read only the account-level spend, which keeps the first currency.
      expect(account?.usageLimits.spend).toEqual({ currency: "CNY", day: 1.25, month: 4 });
    }),
  );

  it.effect("keeps the balance and warns when it no longer covers API calls", () =>
    Effect.gen(function* () {
      const { api } = deepseekAnswering(200, {
        is_available: false,
        balance_infos: [{ currency: "USD", total_balance: "0.03" }],
      });
      const [account] = yield* (yield* api).readAccounts(config, recordBalance);
      expect(account?.usageLimits.windows.map((window) => window.remaining)).toEqual([0.03]);
      expect(account?.usageLimits.unavailable).toBeUndefined();
      expect(account?.usageLimits.notice).toBe("The balance is too low for API calls.");
    }),
  );

  it.effect("skips amounts it cannot parse and reports when none remain", () =>
    Effect.gen(function* () {
      const { api } = deepseekAnswering(200, {
        balance_infos: [{ currency: "CNY", total_balance: "n/a" }],
      });
      const [account] = yield* (yield* api).readAccounts(config, recordBalance);
      expect(account?.usageLimits.unavailable?.message).toBe("DeepSeek reported no balance.");
    }),
  );

  it.effect("rejects a response without balance details", () =>
    Effect.gen(function* () {
      const { api } = deepseekAnswering(200, { is_available: true });
      const error = yield* Effect.flip((yield* api).readAccounts(config, recordBalance));
      expect(error.detail).toBe("DeepSeek returned an unexpected response.");
    }),
  );

  it.effect("names the status, not the body or key, when DeepSeek rejects the key", () =>
    Effect.gen(function* () {
      const { api } = deepseekAnswering(401, { error: "deepseek-secret is invalid" });
      const error = yield* Effect.flip((yield* api).readAccounts(config, recordBalance));
      expect(error.detail).toBe("DeepSeek answered with HTTP 401.");
    }),
  );
});
