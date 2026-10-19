import {
  ServerProviderUsageAvailability,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

/** A drop this large before the scheduled reset means the provider reset the window early. */
const EARLY_RESET_POINTS = 20;
/** Providers reset a little ahead of the advertised time; that is not an early reset. */
const EARLY_RESET_SLACK_MS = 5 * 60_000;
const RESET_MOVED_EARLIER_MS = 60 * 60_000;
const RECENT_ALERT_LIMIT = 20;

const WatchedWindow = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  usedPercent: Schema.Number,
  resetsAt: Schema.optional(Schema.String),
});
type WatchedWindow = typeof WatchedWindow.Type;

export const UsageBaseline = Schema.Struct({
  fingerprint: Schema.optional(Schema.String),
  windows: Schema.Array(WatchedWindow),
  resetCredits: Schema.optional(Schema.Number),
  alert: Schema.optional(ServerProviderUsageAvailability),
  /** Alert ids already raised, so a flapping probe cannot announce the same episode twice. */
  recentAlertIds: Schema.Array(Schema.String),
});
export type UsageBaseline = typeof UsageBaseline.Type;

export const UsageBaselines = Schema.Record(Schema.String, UsageBaseline);
type UsageBaselines = typeof UsageBaselines.Type;

const BASELINES_KEY = "baselines";

// Money windows meter spend, not access.
const isMoneyWindow = (window: ServerProviderUsageWindow): boolean =>
  window.unit !== undefined && /^[A-Z]{3}$/.test(window.unit);

const watchedWindows = (limits: ServerProviderUsageLimits): ReadonlyArray<WatchedWindow> =>
  limits.windows
    .filter((window) => !isMoneyWindow(window))
    .map((window) => ({
      id: window.id,
      label: window.label,
      usedPercent: window.usedPercent,
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    }));

const parseMs = (value: string | undefined): number =>
  value === undefined ? Number.NaN : Date.parse(value);

type AlertDraft = Omit<ServerProviderUsageAvailability, "detectedAt">;

/**
 * Compares a fresh usage report with the last one seen for the instance. The
 * first report, a report from another account (credential fingerprint) and a
 * failed or unsupported probe only move the baseline; they never alert. Reset
 * credits are only ever counted here, never redeemed.
 */
export function diffUsage(input: {
  readonly instanceId: ProviderInstanceId;
  readonly baseline: UsageBaseline | undefined;
  readonly limits: ServerProviderUsageLimits;
  readonly nowMs: number;
}): {
  readonly baseline: UsageBaseline;
  readonly alert: ServerProviderUsageAvailability | null;
} | null {
  const { baseline, limits, instanceId, nowMs } = input;
  if (limits.unavailable !== undefined) return null;
  const windows = watchedWindows(limits);
  const resetCredits = limits.resetCredits?.availableCount;
  const next: UsageBaseline = {
    ...(limits.credentialFingerprint === undefined
      ? baseline?.fingerprint === undefined
        ? {}
        : { fingerprint: baseline.fingerprint }
      : { fingerprint: limits.credentialFingerprint }),
    windows,
    ...(resetCredits === undefined ? {} : { resetCredits }),
    ...(baseline?.alert === undefined ? {} : { alert: baseline.alert }),
    recentAlertIds: baseline?.recentAlertIds ?? [],
  };
  const accountChanged =
    baseline?.fingerprint !== undefined &&
    limits.credentialFingerprint !== undefined &&
    baseline.fingerprint !== limits.credentialFingerprint;
  if (baseline === undefined || accountChanged) return { baseline: next, alert: null };

  const draft = ((): AlertDraft | null => {
    const limitedBefore = baseline.windows.filter((window) => window.usedPercent >= 100);
    if (
      limitedBefore.length > 0 &&
      windows.length > 0 &&
      windows.every((window) => window.usedPercent < 100)
    ) {
      const episode = limitedBefore
        .map((window) => `${window.id}@${window.resetsAt ?? "unscheduled"}`)
        .join(",");
      return {
        id: `${instanceId}:available:${episode}`,
        kind: "available",
        windowLabel: limitedBefore[0]!.label,
      };
    }
    for (const window of windows) {
      const before = baseline.windows.find((candidate) => candidate.id === window.id);
      const scheduledMs = parseMs(before?.resetsAt);
      if (
        before?.resetsAt !== undefined &&
        Number.isFinite(scheduledMs) &&
        before.usedPercent - window.usedPercent >= EARLY_RESET_POINTS &&
        nowMs < scheduledMs - EARLY_RESET_SLACK_MS
      ) {
        return {
          id: `${instanceId}:early-reset:${window.id}@${before.resetsAt}`,
          kind: "early-reset",
          windowLabel: window.label,
        };
      }
    }
    for (const window of windows) {
      const before = baseline.windows.find((candidate) => candidate.id === window.id);
      const previousMs = parseMs(before?.resetsAt);
      const nextMs = parseMs(window.resetsAt);
      if (
        window.resetsAt !== undefined &&
        Number.isFinite(previousMs) &&
        Number.isFinite(nextMs) &&
        nextMs < previousMs - RESET_MOVED_EARLIER_MS
      ) {
        return {
          id: `${instanceId}:reset-moved-earlier:${window.id}@${window.resetsAt}`,
          kind: "reset-moved-earlier",
          windowLabel: window.label,
          resetsAt: window.resetsAt,
        };
      }
    }
    if (
      baseline.resetCredits !== undefined &&
      resetCredits !== undefined &&
      resetCredits > baseline.resetCredits
    ) {
      const credit = limits.resetCredits?.nextCreditId ?? limits.resetCredits?.nextExpiresAt ?? "";
      return {
        id: `${instanceId}:credit-added:${resetCredits}:${credit}`,
        kind: "credit-added",
      };
    }
    return null;
  })();
  if (draft === null || baseline.recentAlertIds.includes(draft.id)) {
    return { baseline: next, alert: null };
  }
  const alert: ServerProviderUsageAvailability = {
    ...draft,
    detectedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
  };
  return {
    baseline: {
      ...next,
      alert,
      recentAlertIds: [...baseline.recentAlertIds, alert.id].slice(-RECENT_ALERT_LIMIT),
    },
    alert,
  };
}

const sameBaseline = (left: UsageBaseline | undefined, right: UsageBaseline): boolean =>
  left !== undefined && JSON.stringify(left) === JSON.stringify(right);

export class UsageAvailabilityWatcher extends Context.Service<
  UsageAvailabilityWatcher,
  {
    /** The latest alert per instance, as clients see it on the provider snapshot. */
    readonly alerts: Effect.Effect<ReadonlyMap<string, ServerProviderUsageAvailability>>;
    readonly decorate: (
      providers: ReadonlyArray<ServerProvider>,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;
    readonly decorateStream: <E, R>(
      providers: Stream.Stream<ReadonlyArray<ServerProvider>, E, R>,
    ) => Stream.Stream<ReadonlyArray<ServerProvider>, E, R>;
  }
>()("t3/provider/UsageAvailabilityWatcher") {}

const withAlerts = (
  providers: ReadonlyArray<ServerProvider>,
  alerts: ReadonlyMap<string, ServerProviderUsageAvailability>,
): ReadonlyArray<ServerProvider> =>
  alerts.size === 0
    ? providers
    : providers.map((provider) => {
        const alert = alerts.get(provider.instanceId);
        return alert === undefined ? provider : { ...provider, usageAvailability: alert };
      });

const alertsOf = (
  baselines: UsageBaselines,
): ReadonlyMap<string, ServerProviderUsageAvailability> =>
  new Map(
    Object.entries(baselines).flatMap(([instanceId, baseline]) =>
      baseline.alert === undefined ? [] : [[instanceId, baseline.alert] as const],
    ),
  );

export const make = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const store = KeyValueStore.toSchemaStore(yield* KeyValueStore.KeyValueStore, UsageBaselines);
  const loaded = yield* store.get(BASELINES_KEY).pipe(
    Effect.map(Option.getOrElse((): UsageBaselines => ({}))),
    Effect.catch((cause) =>
      Effect.logWarning("usage-availability.baselines-unreadable", { cause }).pipe(
        Effect.as<UsageBaselines>({}),
      ),
    ),
  );
  const baselines = yield* SubscriptionRef.make<UsageBaselines>(loaded);
  const alerts = yield* SubscriptionRef.make(alertsOf(loaded));

  const observe = Effect.fn("UsageAvailabilityWatcher.observe")(function* (
    providers: ReadonlyArray<ServerProvider>,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const current = yield* SubscriptionRef.get(baselines);
    const changed: Record<string, UsageBaseline> = {};
    for (const provider of providers) {
      if (provider.usageLimits === undefined) continue;
      const result = diffUsage({
        instanceId: provider.instanceId,
        baseline: current[provider.instanceId],
        limits: provider.usageLimits,
        nowMs,
      });
      if (result === null || sameBaseline(current[provider.instanceId], result.baseline)) continue;
      changed[provider.instanceId] = result.baseline;
      if (result.alert !== null) {
        yield* Effect.logInfo("usage-availability.alert", {
          instanceId: provider.instanceId,
          kind: result.alert.kind,
        });
      }
    }
    if (Object.keys(changed).length === 0) return;
    const next: UsageBaselines = { ...current, ...changed };
    yield* SubscriptionRef.set(baselines, next);
    // Saved before clients hear of an alert, so a restart cannot announce it again.
    yield* store
      .set(BASELINES_KEY, next)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("usage-availability.baselines-not-saved", { cause }),
        ),
      );
    const nextAlerts = alertsOf(next);
    const previousAlerts = yield* SubscriptionRef.get(alerts);
    if (
      nextAlerts.size !== previousAlerts.size ||
      [...nextAlerts].some(([id, alert]) => previousAlerts.get(id)?.id !== alert.id)
    ) {
      yield* SubscriptionRef.set(alerts, nextAlerts);
    }
  });

  yield* Stream.concat(Stream.fromEffect(registry.getProviders), registry.streamChanges).pipe(
    Stream.runForEach((providers) =>
      observe(providers).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("usage-availability.observe-failed", { cause }),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  return UsageAvailabilityWatcher.of({
    alerts: SubscriptionRef.get(alerts),
    decorate: (providers) =>
      SubscriptionRef.get(alerts).pipe(Effect.map((current) => withAlerts(providers, current))),
    decorateStream: (providers) =>
      Stream.zipLatestWith(providers, SubscriptionRef.changes(alerts), withAlerts),
  });
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return Layer.effect(UsageAvailabilityWatcher, make).pipe(
      Layer.provide(
        KeyValueStore.layerFileSystem(
          path.join(config.providerStatusCacheDir, "usage-availability"),
        ).pipe(
          Layer.catch(() =>
            Layer.effectDiscard(
              Effect.logWarning("usage-availability: cache directory unavailable; using memory"),
            ).pipe(Layer.provideMerge(KeyValueStore.layerMemory)),
          ),
        ),
      ),
    );
  }),
);
