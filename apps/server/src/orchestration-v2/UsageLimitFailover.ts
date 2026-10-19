import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type ProviderInstanceId,
  type ServerProvider,
  type UsageRotationDriverSettings,
  type UsageRotationSettings,
} from "@t3tools/contracts";
import { pickRotationAccount } from "@t3tools/shared/usageRotation";
import * as DateTime from "effect/DateTime";

import type { ProjectionLimitFailoverCandidate } from "./ProjectionStore.ts";

const LIMIT_FAILOVER_ID_PREFIX = "limit-failover:";

export const isLimitFailoverMessageId = (messageId: string): boolean =>
  messageId.startsWith(LIMIT_FAILOVER_ID_PREFIX);

/** How long a limit without a reset time keeps its account out of rotation. */
export const LIMIT_FAILOVER_COOLDOWN_MS = 15 * 60_000;

/** The account a limited thread on `sourceInstanceId` moves to, or null when none can take it. */
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
  return pickRotationAccount({
    driver: source.driver,
    rotation: input.rotation,
    providers: input.providers,
    nowMs: input.nowMs,
    excludeInstanceId: source.instanceId,
    cooldowns: input.cooldowns,
    enabledForThread: input.enabledForThread,
  });
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
