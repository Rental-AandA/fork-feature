import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type FalUsageLimitSourceConfig,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";

import { decodeSourceJson, getSourceJson, nonNegative } from "./sourceHttp.ts";

const FAL_API = "https://api.fal.ai/v1";
const FAL_DRIVER = ProviderDriverKind.make("fal");
// The usage endpoint pages its per-endpoint summary; a bound keeps a runaway cursor finite.
const MAX_USAGE_PAGES = 20;

const Billing = Schema.Struct({
  credits: Schema.Struct({ current_balance: Schema.Number, currency: Schema.String }),
});
const Usage = Schema.Struct({
  summary: Schema.optional(Schema.Array(Schema.Struct({ cost_total: Schema.Number }))),
  has_more: Schema.optional(Schema.Boolean),
  next_cursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const billingDetail = (status: number) =>
  status === 401 || status === 403
    ? "The fal key needs billing permission. Use a key with the BILLING or FULL preset."
    : undefined;

export const makeFalApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const spentSince = Effect.fn("FalApi.spentSince")(function* (
    headers: Readonly<Record<string, string>>,
    start: string,
    timeframe: "day" | "month",
  ) {
    let total = 0;
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_USAGE_PAGES; page += 1) {
      const params = new URLSearchParams({ expand: "summary", timeframe, start });
      if (cursor) params.set("cursor", cursor);
      const usage = yield* getSourceJson(client, {
        service: "fal",
        url: `${FAL_API}/models/usage?${params}`,
        headers,
      }).pipe(Effect.flatMap(decodeSourceJson(Usage, "fal")));
      total += (usage.summary ?? []).reduce((sum, entry) => sum + entry.cost_total, 0);
      if (!usage.has_more || !usage.next_cursor) return total;
      cursor = usage.next_cursor;
    }
    return yield* new UsageLimitSourceError({ detail: "fal usage has too many pages." });
  });

  const readAccounts = Effect.fn("FalApi.readAccounts")(function* (
    config: FalUsageLimitSourceConfig,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const headers = { authorization: `Key ${config.apiKey}` };
    const billing = yield* getSourceJson(client, {
      service: "fal",
      url: `${FAL_API}/account/billing?expand=credits`,
      headers,
      statusDetail: billingDetail,
    }).pipe(Effect.flatMap(decodeSourceJson(Billing, "fal")));
    const now = DateTime.formatIso(yield* DateTime.now);
    const currency = billing.credits.currency.trim().toUpperCase() || "USD";
    // Spend needs more permissions than the balance; without them the balance still shows.
    const [day, month] = yield* Effect.all(
      [
        spentSince(headers, `${now.slice(0, 10)}T00:00:00Z`, "day"),
        spentSince(headers, `${now.slice(0, 7)}-01T00:00:00Z`, "month"),
      ],
      { concurrency: 2 },
    ).pipe(Effect.orElseSucceed(() => [undefined, undefined] as const));
    return [
      {
        id: config.label ?? "fal",
        driver: FAL_DRIVER,
        usageLimits: {
          checkedAt: now,
          windows: [
            {
              id: "balance",
              kind: "other",
              label: "Balance",
              usedPercent: 0,
              remaining: nonNegative(billing.credits.current_balance),
              unit: currency,
            },
          ],
          ...(day !== undefined && month !== undefined
            ? { spend: { currency, day: nonNegative(day), month: nonNegative(month) } }
            : {}),
        },
      },
    ];
  });

  return { readAccounts };
});
