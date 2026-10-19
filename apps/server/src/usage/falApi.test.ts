import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeFalApi } from "./falApi.ts";

const config = { kind: "fal", apiKey: "fal-secret", enabled: true } as const;
const NOW = Date.parse("2026-10-20T12:00:00.000Z");

function falAnswering(answer: (url: URL) => { status?: number; body: unknown }) {
  const requests: Array<{ url: URL; auth: string | undefined }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      requests.push({ url, auth: request.headers.authorization });
      const { status = 200, body } = answer(url);
      return HttpClientResponse.fromWeb(request, Response.json(body, { status }));
    }),
  );
  return { requests, api: makeFalApi.pipe(Effect.provideService(HttpClient.HttpClient, http)) };
}

const billing = { username: "team", credits: { current_balance: 24.5, currency: "USD" } };
const usage = (cost: number) => ({ summary: [{ cost_total: cost }], has_more: false });

describe("fal balance and spend", () => {
  it.effect("reports the balance in its currency with today's and this month's spend", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { api, requests } = falAnswering((url) =>
        url.pathname.endsWith("/account/billing")
          ? { body: billing }
          : { body: usage(url.searchParams.get("timeframe") === "day" ? 0.8 : 7.1) },
      );
      const [account] = yield* (yield* api).readAccounts(config);
      expect(requests.every((request) => request.auth === "Key fal-secret")).toBe(true);
      expect(requests.map((request) => request.url.searchParams.get("start")).sort()).toEqual([
        "2026-10-01T00:00:00Z",
        "2026-10-20T00:00:00Z",
        null,
      ]);
      expect(account).toMatchObject({ id: "fal", driver: "fal" });
      expect(account?.usageLimits.windows).toEqual([
        {
          id: "balance",
          kind: "other",
          label: "Balance",
          usedPercent: 0,
          remaining: 24.5,
          unit: "USD",
        },
      ]);
      expect(account?.usageLimits.spend).toEqual({ currency: "USD", day: 0.8, month: 7.1 });
    }),
  );

  it.effect("sums every page of the usage summary", () =>
    Effect.gen(function* () {
      const { api } = falAnswering((url) => {
        if (url.pathname.endsWith("/account/billing")) return { body: billing };
        return url.searchParams.get("cursor") === "next"
          ? { body: { summary: [{ cost_total: 2 }], has_more: false } }
          : {
              body: {
                summary: [{ cost_total: 1 }, { cost_total: 0.5 }],
                has_more: true,
                next_cursor: "next",
              },
            };
      });
      const [account] = yield* (yield* api).readAccounts(config);
      expect(account?.usageLimits.spend).toMatchObject({ day: 3.5, month: 3.5 });
    }),
  );

  it.effect("keeps the balance when the key may not read spend", () =>
    Effect.gen(function* () {
      const { api } = falAnswering((url) =>
        url.pathname.endsWith("/account/billing")
          ? { body: billing }
          : { status: 403, body: { detail: "forbidden" } },
      );
      const [account] = yield* (yield* api).readAccounts(config);
      expect(account?.usageLimits.windows[0]?.remaining).toBe(24.5);
      expect(account?.usageLimits).not.toHaveProperty("spend");
    }),
  );

  it.effect("asks for a billing key when fal refuses the balance", () =>
    Effect.gen(function* () {
      for (const status of [401, 403]) {
        const { api } = falAnswering(() => ({
          status,
          body: { detail: "fal-secret lacks scope" },
        }));
        const error = yield* Effect.flip((yield* api).readAccounts(config));
        expect(error.detail).toBe(
          "The fal key needs billing permission. Use a key with the BILLING or FULL preset.",
        );
      }
    }),
  );

  it.effect("rejects a balance response without credits", () =>
    Effect.gen(function* () {
      const { api } = falAnswering(() => ({ body: { username: "team" } }));
      const error = yield* Effect.flip((yield* api).readAccounts(config));
      expect(error.detail).toBe("fal returned an unexpected response.");
    }),
  );
});
