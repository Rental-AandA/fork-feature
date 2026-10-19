import {
  ProviderDriverKind,
  type DeepSeekUsageLimitSourceConfig,
  type UsageLimitSourceAccount,
  type UsageLimitSourceError,
} from "@t3tools/contracts";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import { decodeSourceJson, getSourceJson, nonNegative } from "./sourceHttp.ts";
import type { DerivedSpend } from "./spendHistory.ts";

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const DEEPSEEK_DRIVER = ProviderDriverKind.make("deepseek");

// DeepSeek sends amounts as decimal strings.
const Balance = Schema.Struct({
  is_available: Schema.optional(Schema.Boolean),
  balance_infos: Schema.Array(
    Schema.Struct({
      currency: Schema.String,
      total_balance: Schema.Union([Schema.String, Schema.Number]),
    }),
  ),
});

const parseAmount = (value: string | number) => {
  const amount = typeof value === "number" ? value : Number(value.trim());
  return value === "" || !Number.isFinite(amount) ? null : amount;
};

/**
 * DeepSeek has no spend endpoint, so spend is derived from balance readings by
 * `recordBalance`, which the caller keys to this source.
 */
export const makeDeepSeekApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const readAccounts = Effect.fn("DeepSeekApi.readAccounts")(function* (
    config: DeepSeekUsageLimitSourceConfig,
    recordBalance: (currency: string, balance: number) => Effect.Effect<DerivedSpend>,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const body = yield* getSourceJson(client, {
      service: "DeepSeek",
      url: DEEPSEEK_BALANCE_URL,
      headers: { authorization: `Bearer ${config.apiKey}` },
    }).pipe(Effect.flatMap(decodeSourceJson(Balance, "DeepSeek")));
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const account = { id: config.label ?? "DeepSeek", driver: DEEPSEEK_DRIVER };
    const balances = body.balance_infos.flatMap((info) => {
      const amount = parseAmount(info.total_balance);
      const currency = info.currency.trim().toUpperCase();
      return amount === null || !currency ? [] : [{ currency, amount }];
    });
    const spends = yield* Effect.forEach(balances, ({ currency, amount }) =>
      recordBalance(currency, amount),
    );
    if (balances.length === 0 || body.is_available === false) {
      return [
        {
          ...account,
          usageLimits: makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message:
              balances.length === 0
                ? "DeepSeek reported no balance."
                : "DeepSeek says the balance is too low for API calls.",
          }),
        },
      ];
    }
    // The spend field carries one currency; accounts normally hold only one.
    const [first] = balances;
    const [firstSpend] = spends;
    return [
      {
        ...account,
        usageLimits: {
          checkedAt,
          windows: balances.map(({ currency, amount }) => ({
            id: `balance-${currency}`,
            kind: "other" as const,
            label: `Balance (${currency})`,
            usedPercent: 0,
            remaining: nonNegative(amount),
            unit: currency,
          })),
          ...(first && firstSpend
            ? {
                spend: {
                  currency: first.currency,
                  day: firstSpend.day,
                  month: firstSpend.month,
                },
              }
            : {}),
        },
      },
    ];
  });

  return { readAccounts };
});
