import {
  ProviderDriverKind,
  type OpenRouterUsageLimitSourceConfig,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  type UsageLimitSourceError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import { decodeSourceJson, getSourceJson, nonNegative, usedPercentOf } from "./sourceHttp.ts";

const OPENROUTER_API = "https://openrouter.ai/api/v1";
const OPENROUTER_DRIVER = ProviderDriverKind.make("openrouter");

const OptionalAmount = Schema.optional(Schema.NullOr(Schema.Number));
const KeyInfo = Schema.Struct({
  data: Schema.Struct({
    limit: OptionalAmount,
    limit_remaining: OptionalAmount,
    usage: OptionalAmount,
    usage_daily: OptionalAmount,
    usage_weekly: OptionalAmount,
    usage_monthly: OptionalAmount,
  }),
});
const Credits = Schema.Struct({
  data: Schema.Struct({ total_credits: Schema.Number, total_usage: Schema.Number }),
});

const spendEntry = <K extends string>(period: K, value: number | null | undefined) =>
  value === null || value === undefined
    ? {}
    : ({ [period]: nonNegative(value) } as { readonly [P in K]: number });

/**
 * `/key` works with the inference key but describes only that key; the
 * account balance in `/credits` needs a management key.
 */
export const makeOpenRouterApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const readAccounts = Effect.fn("OpenRouterApi.readAccounts")(function* (
    config: OpenRouterUsageLimitSourceConfig,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const key = yield* getSourceJson(client, {
      service: "OpenRouter",
      url: `${OPENROUTER_API}/key`,
      headers: { authorization: `Bearer ${config.apiKey}` },
    }).pipe(Effect.flatMap(decodeSourceJson(KeyInfo, "OpenRouter")));
    // The balance is extra: a refused or failing management key leaves the key's own spend.
    const credits =
      config.managementKey.length === 0
        ? null
        : yield* getSourceJson(client, {
            service: "OpenRouter",
            url: `${OPENROUTER_API}/credits`,
            headers: { authorization: `Bearer ${config.managementKey}` },
            statusDetail: (status) =>
              status === 401 || status === 403
                ? `OpenRouter refused the management key (HTTP ${status}).`
                : undefined,
          }).pipe(Effect.flatMap(decodeSourceJson(Credits, "OpenRouter")), Effect.result);
    const checkedAt = DateTime.formatIso(yield* DateTime.now);

    const windows: ServerProviderUsageWindow[] = [];
    if (credits?._tag === "Success") {
      const { total_credits: total, total_usage: used } = credits.success.data;
      windows.push({
        id: "credits",
        kind: "other",
        label: "Credits",
        usedPercent: usedPercentOf(used, total),
        remaining: nonNegative(total - used),
        limit: nonNegative(total),
        unit: "USD",
      });
    }
    const { limit, limit_remaining: limitRemaining, usage } = key.data;
    if (limit !== null && limit !== undefined) {
      const remaining = nonNegative(limitRemaining ?? limit - (usage ?? 0));
      windows.push({
        id: "key-limit",
        kind: "other",
        label: "Key limit",
        usedPercent: usedPercentOf(limit - remaining, limit),
        remaining,
        limit: nonNegative(limit),
        unit: "USD",
      });
    }
    const spend = {
      ...spendEntry("day", key.data.usage_daily),
      ...spendEntry("week", key.data.usage_weekly),
      ...spendEntry("month", key.data.usage_monthly),
    };
    return [
      {
        id: config.label ?? "OpenRouter",
        driver: OPENROUTER_DRIVER,
        usageLimits: {
          checkedAt,
          windows,
          ...(Object.keys(spend).length > 0 ? { spend: { currency: "USD", ...spend } } : {}),
          ...(credits?._tag === "Failure"
            ? { notice: `Account balance unavailable: ${credits.failure.detail}` }
            : {}),
        },
      },
    ];
  });

  return { readAccounts };
});
