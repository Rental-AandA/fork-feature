import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type ProviderInstanceId,
  type ThreadId,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings as ServerSettingsType,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageAvailabilityWatcher from "../provider/UsageAvailabilityWatcher.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { limitCooldownUntilMs, planLimitFailover } from "./UsageLimitFailover.ts";

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

interface Cooldown {
  readonly untilMs: number;
  /** When the limit that started it was hit; a later reopen alert ends it early. */
  readonly sinceMs: number;
}

const makeFailover = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const watcher = yield* Effect.serviceOption(UsageAvailabilityWatcher.UsageAvailabilityWatcher);
  // Usage bars lag a fresh limit; remembering it keeps a thread from bouncing back.
  const cooldowns = new Map<ProviderInstanceId, Cooldown>();
  const attempted = new Set<string>();
  return Effect.fn("UsageLimitRecoveryWorker.failover")(function* (
    settings: ServerSettingsType,
    nowMs: number,
  ) {
    const rotation = settings.usageRotation;
    const moved = new Set<ThreadId>();
    if (!Object.values(rotation).some((entry) => entry.enabled)) return moved;
    const candidates = yield* projections.getLimitFailoverCandidates();
    const candidateKeys = new Set(candidates.map((thread) => `${thread.id}:${thread.latestRunId}`));
    for (const key of attempted) if (!candidateKeys.has(key)) attempted.delete(key);
    if (candidates.length === 0) return moved;
    const providers = yield* registry.getProviders;
    const alerts = Option.isSome(watcher) ? yield* watcher.value.alerts : new Map();
    for (const thread of candidates) {
      const instanceId = thread.latestRun.providerInstanceId;
      const existing = cooldowns.get(instanceId);
      cooldowns.set(instanceId, {
        untilMs: Math.max(existing?.untilMs ?? 0, limitCooldownUntilMs(thread)),
        sinceMs: Math.max(
          existing?.sinceMs ?? 0,
          DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt),
        ),
      });
    }
    for (const [instanceId, cooldown] of cooldowns) {
      const alert = alerts.get(instanceId);
      const reopened =
        alert !== undefined &&
        (alert.kind === "available" || alert.kind === "early-reset") &&
        Date.parse(alert.detectedAt) >= cooldown.sinceMs;
      if (cooldown.untilMs <= nowMs || reopened) cooldowns.delete(instanceId);
    }
    const activeCooldowns = new Map(
      [...cooldowns].map(([instanceId, cooldown]) => [instanceId, cooldown.untilMs] as const),
    );
    for (const thread of candidates) {
      const key = `${thread.id}:${thread.latestRunId}`;
      if (attempted.has(key)) continue;
      const plan = planLimitFailover({
        thread,
        rotation,
        providers,
        cooldowns: activeCooldowns,
        nowMs,
        // The same project check a user dispatch passes; a disabled account is never a target.
        enabledForThread: (instanceId) =>
          resolveProjectProviderInstanceEnabled(settings, thread.projectId, instanceId),
      });
      if (plan.type === "skip") continue;
      attempted.add(key);
      const dispatched = yield* threads.dispatch(plan.command).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-failover.dispatch-failed", {
            threadId: thread.id,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!dispatched) continue;
      moved.add(thread.id);
      yield* Effect.logInfo("orchestration-v2.limit-failover.dispatched", {
        threadId: thread.id,
        from: thread.latestRun.providerInstanceId,
        to: plan.targetInstanceId,
      });
    }
    return moved;
  });
});

export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const failover = yield* makeFailover;
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    // Rotation runs first; a thread it moved to another account no longer waits for a reset.
    const movedThreadIds = yield* failover(preferences, nowMs);
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
    });
    for (const thread of candidates) {
      if (movedThreadIds.has(thread.id)) continue;
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      yield* threads.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
