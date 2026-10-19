import {
  CommandId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageRotationDriverSettings,
  type UsageRotationSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ProjectionLimitFailoverCandidate } from "./ProjectionStore.ts";

const LIMIT_FAILOVER_ID_PREFIX = "limit-failover:";

export const isLimitFailoverMessageId = (messageId: string): boolean =>
  messageId.startsWith(LIMIT_FAILOVER_ID_PREFIX);

/** How long a limit without a reset time keeps its account out of rotation. */
export const LIMIT_FAILOVER_COOLDOWN_MS = 15 * 60_000;

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
 * Only instances listed in the rotation order take part. A new account of the
 * same driver, such as a pay-as-you-go API key, never starts paying for work
 * the user did not route to it.
 */
export function pickFailoverInstance(input: {
  readonly sourceInstanceId: ProviderInstanceId;
  readonly rotation: UsageRotationDriverSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  /** Accounts that recently hit a limit, until the epoch millisecond they reopen. */
  readonly cooldowns: ReadonlyMap<ProviderInstanceId, number>;
  readonly nowMs: number;
  /** Project-level provider switches; a thread never moves to an account its project turned off. */
  readonly enabledForThread: (instanceId: ProviderInstanceId) => boolean;
}): ServerProvider | null {
  const source = input.providers.find((provider) => provider.instanceId === input.sourceInstanceId);
  if (source === undefined) return null;
  const orderIndex = (provider: ServerProvider) =>
    input.rotation.order.indexOf(provider.instanceId);
  const eligible = input.providers.flatMap((provider) => {
    const cooldownUntil = input.cooldowns.get(provider.instanceId);
    const state = usageLimitState(provider, input.nowMs);
    return provider.driver === source.driver &&
      provider.instanceId !== source.instanceId &&
      orderIndex(provider) !== -1 &&
      provider.enabled &&
      input.enabledForThread(provider.instanceId) &&
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
  const ranked = eligible.toSorted(
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

/** Keeps the model when the target account offers it, otherwise uses the account's default. */
export function failoverModelSelection(
  source: ModelSelection,
  target: ServerProvider,
): ModelSelection | null {
  const same = target.models.find(
    (model) => model.slug === source.model || model.aliases?.includes(source.model) === true,
  );
  if (same !== undefined) {
    return { ...source, instanceId: target.instanceId, model: same.slug };
  }
  const fallback = target.models.find((model) => model.isDefault === true) ?? target.models[0];
  return fallback === undefined ? null : { instanceId: target.instanceId, model: fallback.slug };
}

export type LimitFailoverSkipReason =
  | "rotation-off"
  | "manually-switched"
  | "snoozed"
  | "subagent"
  | "unknown-account"
  | "no-account"
  | "no-model";

export type LimitFailoverPlan =
  | {
      readonly type: "dispatch";
      readonly command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
      readonly targetInstanceId: ProviderInstanceId;
    }
  | { readonly type: "skip"; readonly reason: LimitFailoverSkipReason };

export function planLimitFailover(input: {
  readonly thread: ProjectionLimitFailoverCandidate;
  readonly rotation: UsageRotationSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly cooldowns: ReadonlyMap<ProviderInstanceId, number>;
  readonly nowMs: number;
  readonly enabledForThread: (instanceId: ProviderInstanceId) => boolean;
}): LimitFailoverPlan {
  const { thread } = input;
  const run = thread.latestRun;
  const source = input.providers.find((provider) => provider.instanceId === run.providerInstanceId);
  if (source === undefined) return { type: "skip", reason: "unknown-account" };
  const rotation = input.rotation[source.driver];
  if (rotation?.enabled !== true) return { type: "skip", reason: "rotation-off" };
  // A selection changed after the failure is the user's choice of where to continue.
  if (thread.providerInstanceId !== run.providerInstanceId) {
    return { type: "skip", reason: "manually-switched" };
  }
  if (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > input.nowMs) {
    return { type: "skip", reason: "snoozed" };
  }
  if (thread.lineage.relationshipToParent === "subagent") {
    return { type: "skip", reason: "subagent" };
  }
  const target = pickFailoverInstance({
    sourceInstanceId: source.instanceId,
    rotation,
    providers: input.providers,
    cooldowns: input.cooldowns,
    nowMs: input.nowMs,
    enabledForThread: input.enabledForThread,
  });
  if (target === null) return { type: "skip", reason: "no-account" };
  const modelSelection = failoverModelSelection(run.modelSelection, target);
  if (modelSelection === null) return { type: "skip", reason: "no-model" };
  // One id per limited run: a repeated sweep or a restart replays the same command.
  const id = `${LIMIT_FAILOVER_ID_PREFIX}${thread.id}:${run.id}`;
  return {
    type: "dispatch",
    targetInstanceId: target.instanceId,
    command: {
      type: "message.dispatch",
      commandId: CommandId.make(id),
      messageId: MessageId.make(id),
      threadId: thread.id,
      manualContinuationOfRunId: run.id,
      modelSelection,
      text: "Continue where you left off.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "server",
    },
  };
}

/** When a limited account reopens: its reset time, or a fixed wait when the provider gave none. */
export function limitCooldownUntilMs(thread: ProjectionLimitFailoverCandidate): number {
  const resetMs =
    thread.usageLimitResetAt === null || thread.usageLimitResetAt === undefined
      ? Number.NaN
      : Date.parse(thread.usageLimitResetAt);
  if (Number.isFinite(resetMs)) return resetMs;
  return (
    DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt) +
    LIMIT_FAILOVER_COOLDOWN_MS
  );
}
