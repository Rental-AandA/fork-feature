import {
  isProviderAvailable,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageRotationDriverSettings,
} from "@t3tools/contracts";

// Money windows meter spend, not access: an account stays usable at any spend.
const isMoneyWindow = (window: ServerProviderUsageWindow): boolean =>
  window.unit !== undefined && /^[A-Z]{3}$/.test(window.unit);

const hasReset = (window: ServerProviderUsageWindow, nowMs: number): boolean =>
  window.resetsAt !== undefined && Date.parse(window.resetsAt) <= nowMs;

const accessWindows = (provider: ServerProvider): ReadonlyArray<ServerProviderUsageWindow> =>
  provider.usageLimits?.windows.filter((window) => !isMoneyWindow(window)) ?? [];

/**
 * `unknown` covers accounts that report no windows or whose probe failed: they
 * may still work, so rotation tries them only after every account known to be open.
 */
export function usageLimitState(
  provider: ServerProvider,
  nowMs: number,
): "limited" | "open" | "unknown" {
  if (provider.usageLimits === undefined || provider.usageLimits.unavailable !== undefined) {
    return "unknown";
  }
  const windows = accessWindows(provider);
  if (windows.length === 0) return "unknown";
  return windows.some((window) => window.usedPercent >= 100 && !hasReset(window, nowMs))
    ? "limited"
    : "open";
}

const earliestWeeklyResetMs = (provider: ServerProvider): number =>
  Math.min(
    Infinity,
    ...accessWindows(provider).flatMap((window) => {
      if (window.kind !== "weekly" || window.resetsAt === undefined) return [];
      const resetMs = Date.parse(window.resetsAt);
      return Number.isFinite(resetMs) ? [resetMs] : [];
    }),
  );

const remainingPercent = (provider: ServerProvider): number => {
  const windows = accessWindows(provider);
  return windows.length === 0
    ? -Infinity
    : 100 - Math.max(...windows.map((window) => window.usedPercent));
};

/**
 * The account rotation moves a limited thread to: the server uses it for the move, clients to
 * show which account is next. Only instances listed in the rotation order take part, so a new
 * account of the same driver, such as a pay-as-you-go API key, never starts paying for work the
 * user did not route to it.
 */
export function pickRotationAccount(input: {
  readonly driver: ProviderDriverKind;
  readonly rotation: UsageRotationDriverSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
  /** The limited account the thread leaves. */
  readonly excludeInstanceId?: ProviderInstanceId | undefined;
  /** Accounts that recently hit a limit, until the epoch millisecond they reopen. */
  readonly cooldowns?: ReadonlyMap<ProviderInstanceId, number>;
  /** Project-level provider switches; a thread never moves to an account its project turned off. */
  readonly enabledForThread?: (instanceId: ProviderInstanceId) => boolean;
}): ServerProvider | null {
  const orderIndex = (provider: ServerProvider) =>
    input.rotation.order.indexOf(provider.instanceId);
  const eligible = input.providers.flatMap((provider) => {
    const cooldownUntil = input.cooldowns?.get(provider.instanceId);
    const state = usageLimitState(provider, input.nowMs);
    return provider.driver === input.driver &&
      provider.instanceId !== input.excludeInstanceId &&
      orderIndex(provider) !== -1 &&
      provider.enabled &&
      (input.enabledForThread?.(provider.instanceId) ?? true) &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.status !== "error" &&
      provider.status !== "disabled" &&
      provider.auth.status === "authenticated" &&
      provider.models.length > 0 &&
      (cooldownUntil === undefined || cooldownUntil <= input.nowMs) &&
      state !== "limited"
      ? [{ provider, known: state === "open" }]
      : [];
  });
  const strategyRank = (provider: ServerProvider): number => {
    switch (input.rotation.strategy) {
      case "order":
        return 0;
      case "earliest-reset":
        return earliestWeeklyResetMs(provider);
      case "most-remaining":
        return -remainingPercent(provider);
    }
  };
  const ranked = [...eligible].sort(
    (left, right) =>
      Number(right.known) - Number(left.known) ||
      // Infinity - Infinity is NaN; equal ranks fall through to the order.
      (strategyRank(left.provider) === strategyRank(right.provider)
        ? 0
        : strategyRank(left.provider) < strategyRank(right.provider)
          ? -1
          : 1) ||
      orderIndex(left.provider) - orderIndex(right.provider),
  );
  return ranked[0]?.provider ?? null;
}
