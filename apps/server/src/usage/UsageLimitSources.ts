import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  ProviderDriverKind,
  UsageLimitSourceError,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ServerSettings,
  type UsageLimitSourceConfig,
  type UsageLimitSourceId,
  type UsageLimitSourceKind,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as Settings from "../serverSettings.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";
import { makeElevenLabsApi } from "./elevenlabsApi.ts";

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly refresh: Effect.Effect<void>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
  }
>()("t3/usage/UsageLimitSources") {}

const CANVA_BILLING_URL = "https://www.canva.com/settings/billing-and-plans";

type SourceReader<K extends UsageLimitSourceKind> = (
  config: Extract<UsageLimitSourceConfig, { readonly kind: K }>,
) => Effect.Effect<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError>;

const missingKey = (detail: string) => Effect.fail(new UsageLimitSourceError({ detail }));

// Canva documents no API for AI credits, so the source only points at its billing page.
const readCanva: SourceReader<"canva"> = (config) =>
  DateTime.now.pipe(
    Effect.map((now) => [
      {
        id: config.label ?? "Canva",
        driver: ProviderDriverKind.make("canva"),
        usageLimits: {
          ...makeUnavailableUsageLimits({
            checkedAt: DateTime.formatIso(now),
            reason: "unsupported",
            message: "Canva zeigt KI-Credits nur in der Abrechnung",
          }),
          externalUsage: { label: "Canva-Abrechnung", url: CANVA_BILLING_URL },
        },
      },
    ]),
  );

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  if (config.kind === "elevenlabs") return "ElevenLabs";
  if (config.kind === "canva") return "Canva";
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const elevenlabs = yield* makeElevenLabsApi;
  const settingsService = yield* Settings.ServerSettingsService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  const readers: { readonly [K in UsageLimitSourceKind]: SourceReader<K> } = {
    cliproxy: (config) =>
      config.managementKey.length === 0
        ? missingKey("No management key configured.")
        : api.readAccounts(config),
    elevenlabs: (config) =>
      config.apiKey.length === 0
        ? missingKey("No API key configured.")
        : elevenlabs.readAccounts(config),
    canva: readCanva,
  };
  const readAccounts = <K extends UsageLimitSourceKind>(
    config: Extract<UsageLimitSourceConfig, { readonly kind: K }>,
  ) => (readers[config.kind] as SourceReader<K>)(config);

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = { id, kind: config.kind, label: sourceLabel(id, config), checkedAt } as const;
    const accounts = yield* readAccounts(config).pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: accounts.failure.detail };
    }
    return { ...base, accounts: accounts.success };
  });

  const publish = (next: ReadonlyArray<UsageLimitSourceSnapshot>) =>
    Effect.gen(function* () {
      const changed = yield* Ref.modify(stateRef, (previous) =>
        Equal.equals(previous, next) ? [false, previous] : [true, next],
      );
      if (changed) yield* PubSub.publish(changes, next);
    });

  // One refresh at a time: a slow hub read started before a settings change
  // must not publish after the change's own refresh and resurrect a removed
  // source. Callers queue behind the in-flight run and see current settings.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    const snapshots = yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
    yield* publish(snapshots);
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  // Shares the refresh lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = (input: UsageLimitSourceConsumeResetCreditInput) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          () => new UsageLimitSourceError({ detail: "Could not read hub settings." }),
        ),
      );
      const config = settings.usageLimitSources[input.sourceId];
      if (!config?.enabled || config.kind !== "cliproxy" || !config.managementKey) {
        return yield* new UsageLimitSourceError({
          detail: "The usage limit source is missing or disabled.",
        });
      }
      const result = yield* api.consume(config, input.accountId, input.creditId);
      const snapshot = yield* readSource(input.sourceId, config);
      const previous = yield* Ref.get(stateRef);
      yield* publish(previous.map((source) => (source.id === input.sourceId ? snapshot : source)));
      return result;
    }).pipe(refreshLock.withPermits(1));

  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) =>
        Effect.sleep(Duration.toMillis(Duration.fromInputUnsafe(wait)) <= 0 ? "60 seconds" : wait),
      ),
      Effect.andThen(backgroundPolicy.shouldRunScopeWork({ type: "provider-status" })),
      Effect.flatMap((shouldRun) => (shouldRun ? refresh : Effect.void)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    consumeResetCredit,
    refresh,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make);
