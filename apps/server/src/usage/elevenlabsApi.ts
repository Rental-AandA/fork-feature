import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type ElevenLabsUsageLimitSourceConfig,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

const Subscription = Schema.Struct({
  tier: Schema.optional(Schema.NullOr(Schema.String)),
  character_count: Schema.Number,
  character_limit: Schema.Number,
  next_character_count_reset_unix: Schema.optional(Schema.NullOr(Schema.Number)),
});
const decodeSubscription = Schema.decodeUnknownEffect(Subscription);

const ELEVENLABS_DRIVER = ProviderDriverKind.make("elevenlabs");

// Error bodies can echo request details, so only the status or failure kind reaches the client.
const describeFailure = (error: unknown) => {
  if (Cause.isTimeoutError(error)) return "ElevenLabs did not answer within 15 seconds.";
  if (HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError") {
    return `ElevenLabs answered with HTTP ${error.reason.response.status}.`;
  }
  return "The ElevenLabs subscription request failed.";
};

const isoFromUnixSeconds = (value: number | null | undefined) => {
  if (value === null || value === undefined) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
};

export const makeElevenLabsApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const readAccounts = Effect.fn("ElevenLabsApi.readAccounts")(function* (
    config: ElevenLabsUsageLimitSourceConfig,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const url = yield* Effect.try({
      try: () =>
        new URL(
          "v1/user/subscription",
          config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`,
        ).toString(),
      catch: () => new UsageLimitSourceError({ detail: "The ElevenLabs URL is not valid." }),
    });
    const body = yield* client
      .execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("xi-api-key", config.apiKey)),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("15 seconds"),
        Effect.mapError((error) => new UsageLimitSourceError({ detail: describeFailure(error) })),
      );
    const subscription = yield* decodeSubscription(body).pipe(
      Effect.mapError(
        () =>
          new UsageLimitSourceError({
            detail: "ElevenLabs returned an unexpected subscription response.",
          }),
      ),
    );
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const plan = subscription.tier?.trim();
    const account = {
      id: config.label ?? "ElevenLabs",
      driver: ELEVENLABS_DRIVER,
      ...(plan ? { plan } : {}),
    };
    const limit = subscription.character_limit;
    if (!(limit > 0)) {
      return [
        {
          ...account,
          usageLimits: makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "ElevenLabs reports no character limit for this subscription.",
          }),
        },
      ];
    }
    const used = Math.max(0, subscription.character_count);
    const resetsAt = isoFromUnixSeconds(subscription.next_character_count_reset_unix);
    return [
      {
        ...account,
        usageLimits: {
          checkedAt,
          windows: [
            {
              id: "characters",
              kind: "monthly",
              label: "Characters",
              usedPercent: Math.min(100, (used / limit) * 100),
              remaining: Math.max(0, limit - used),
              limit,
              unit: "characters",
              ...(resetsAt ? { resetsAt } : {}),
            },
          ],
        },
      },
    ];
  });

  return { readAccounts };
});
