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
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerConfig } from "../config.ts";
import * as Settings from "../serverSettings.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";
import { makeDeepSeekApi } from "./deepseekApi.ts";
import { makeElevenLabsApi } from "./elevenlabsApi.ts";
import { makeFalApi } from "./falApi.ts";
import { makeHiggsfieldApi, type SaveRefreshToken } from "./higgsfieldApi.ts";
import { makeOpenRouterApi } from "./openrouterApi.ts";
import { makeSpendHistory } from "./spendHistory.ts";

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
const TYPESAFE_CONSOLE_URL = "https://console.typesafe.ai";

const KIND_LABELS = {
  elevenlabs: "ElevenLabs",
  canva: "Canva",
  fal: "fal",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  typesafe: "Jev",
  higgsfield: "Higgsfield",
} as const satisfies Record<Exclude<UsageLimitSourceKind, "cliproxy">, string>;

type SourceReader<K extends UsageLimitSourceKind> = (
  config: Extract<UsageLimitSourceConfig, { readonly kind: K }>,
  id: UsageLimitSourceId,
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
            message: "Canva shows AI credits only on its billing page.",
          }),
          externalUsage: { label: "Canva billing", url: CANVA_BILLING_URL },
        },
      },
    ]),
  );

// TypeSafe documents no balance or usage API. Spend will be counted from the
// tokens winnow reports once it is connected; until then the console is the only view.
const readTypesafe: SourceReader<"typesafe"> = (config) =>
  DateTime.now.pipe(
    Effect.map((now) => {
      const credit =
        config.startCredit === undefined
          ? ""
          : ` Starting credit: $${config.startCredit.toFixed(2)}${config.startDate ? ` since ${config.startDate}` : ""}.`;
      return [
        {
          id: config.label ?? "Jev",
          driver: ProviderDriverKind.make("typesafe"),
          usageLimits: {
            ...makeUnavailableUsageLimits({
              checkedAt: DateTime.formatIso(now),
              reason: "unsupported",
              message: `Jev usage is counted once winnow is connected.${credit}`,
            }),
            externalUsage: { label: "TypeSafe console", url: TYPESAFE_CONSOLE_URL },
          },
        },
      ];
    }),
  );

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  if (config.kind !== "cliproxy") return KIND_LABELS[config.kind];
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
  const fal = yield* makeFalApi;
  const deepseek = yield* makeDeepSeekApi;
  const openrouter = yield* makeOpenRouterApi;
  const higgsfield = yield* makeHiggsfieldApi;
  const spendHistory = yield* makeSpendHistory(
    (yield* Path.Path).join((yield* ServerConfig).stateDir, "usage-spend.json"),
  );
  const settingsService = yield* Settings.ServerSettingsService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  // Compares before writing so a reconnect that landed meanwhile is never overwritten.
  const saveHiggsfieldToken =
    (id: UsageLimitSourceId): SaveRefreshToken =>
    (previous, next) =>
      Effect.gen(function* () {
        const settings = yield* settingsService.getSettings;
        const source = settings.usageLimitSources[id];
        if (source?.kind !== "higgsfield" || source.refreshToken !== previous) return false;
        yield* settingsService.updateSettings({
          usageLimitSources: { [id]: { ...source, refreshToken: next } },
        });
        return true;
      }).pipe(
        Effect.mapError(
          () =>
            new UsageLimitSourceError({
              detail:
                "Could not save the renewed Higgsfield sign-in. Retrying on the next refresh.",
            }),
        ),
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
    fal: (config) =>
      config.apiKey.length === 0 ? missingKey("No API key configured.") : fal.readAccounts(config),
    deepseek: (config, id) =>
      config.apiKey.length === 0
        ? missingKey("No API key configured.")
        : deepseek.readAccounts(config, (currency, balance) =>
            spendHistory.record(`${id}:${currency}`, balance),
          ),
    openrouter: (config) =>
      config.apiKey.length === 0
        ? missingKey("No API key configured.")
        : openrouter.readAccounts(config),
    typesafe: readTypesafe,
    higgsfield: (config, id) => higgsfield.readAccounts(id, config, saveHiggsfieldToken(id)),
  };
  const readAccounts = <K extends UsageLimitSourceKind>(
    config: Extract<UsageLimitSourceConfig, { readonly kind: K }>,
    id: UsageLimitSourceId,
  ) => (readers[config.kind] as SourceReader<K>)(config, id);

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = { id, kind: config.kind, label: sourceLabel(id, config), checkedAt } as const;
    const accounts = yield* readAccounts(config, id).pipe(Effect.result);
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
