import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const UsageRotationStrategy = Schema.Literals(["order", "earliest-reset", "most-remaining"]);
export type UsageRotationStrategy = typeof UsageRotationStrategy.Type;

/**
 * Account rotation for one driver family. Off by default: moving a limited
 * thread to another account changes which subscription pays for the work.
 */
export const UsageRotationDriverSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  strategy: UsageRotationStrategy.pipe(Schema.withDecodingDefault(Effect.succeed("order"))),
  /** Preferred order and tie-break. Instances missing here rank after it, by id. */
  order: Schema.Array(ProviderInstanceId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type UsageRotationDriverSettings = typeof UsageRotationDriverSettings.Type;

export const UsageRotationSettings = Schema.Record(ProviderDriverKind, UsageRotationDriverSettings);
export type UsageRotationSettings = typeof UsageRotationSettings.Type;

/** Entry replacement: each entry replaces that driver's settings and `null` removes it. */
export const UsageRotationSettingsPatch = Schema.Record(
  ProviderDriverKind,
  Schema.NullOr(UsageRotationDriverSettings),
);
export type UsageRotationSettingsPatch = typeof UsageRotationSettingsPatch.Type;

export const ServerProviderUsageAvailabilityKind = Schema.Literals([
  "available",
  "early-reset",
  "reset-moved-earlier",
  "credit-added",
]);
export type ServerProviderUsageAvailabilityKind = typeof ServerProviderUsageAvailabilityKind.Type;

/**
 * The latest availability change the server detected for an instance. `id`
 * names the limit episode, so every client notifies once per episode and a
 * reconnect or restart that replays the same alert stays quiet.
 */
export const ServerProviderUsageAvailability = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ServerProviderUsageAvailabilityKind,
  detectedAt: IsoDateTime,
  windowLabel: Schema.optional(TrimmedNonEmptyString),
  resetsAt: Schema.optional(IsoDateTime),
});
export type ServerProviderUsageAvailability = typeof ServerProviderUsageAvailability.Type;
