import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageRotationSettings,
} from "@t3tools/contracts";
import { usageLimitState } from "@t3tools/shared/usageRotation";
import * as DateTime from "effect/DateTime";

import type { ProjectionLimitFailoverCandidate } from "./ProjectionStore.ts";
import {
  failoverModelSelection,
  isLimitFailoverMessageId,
  LIMIT_FAILOVER_COOLDOWN_MS,
  limitCooldownUntilMs,
  pickFailoverInstance,
  planLimitFailover,
} from "./UsageLimitFailover.ts";

const NOW_MS = Date.parse("2026-10-20T12:00:00.000Z");
const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claude");
const id = ProviderInstanceId.make;

const window = (
  usedPercent: number,
  overrides: Partial<ServerProviderUsageWindow> = {},
): ServerProviderUsageWindow => ({
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  resetsAt: "2026-10-25T00:00:00.000Z",
  ...overrides,
});

const provider = (
  instanceId: string,
  windows: ReadonlyArray<ServerProviderUsageWindow> | null,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: id(instanceId),
  driver: codex,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-20T12:00:00.000Z",
  models: [
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null },
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, isDefault: true, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
  ...(windows === null
    ? {}
    : { usageLimits: { checkedAt: "2026-10-20T12:00:00.000Z", windows: [...windows] } }),
  ...overrides,
});

const rotation = (
  order: ReadonlyArray<string>,
  strategy: "order" | "earliest-reset" | "most-remaining" = "order",
): UsageRotationSettings => ({
  [codex]: { enabled: true, strategy, order: order.map((value) => id(value)) },
});

const pick = (
  providers: ReadonlyArray<ServerProvider>,
  order: ReadonlyArray<string>,
  strategy?: "order" | "earliest-reset" | "most-remaining",
  cooldowns: ReadonlyMap<ProviderInstanceId, number> = new Map(),
) =>
  pickFailoverInstance({
    sourceInstanceId: id("codex-1"),
    rotation: rotation(order, strategy)[codex]!,
    providers,
    cooldowns,
    nowMs: NOW_MS,
    enabledForThread: (instanceId) => instanceId !== id("codex-disabled"),
  })?.instanceId ?? null;

const thread = (
  overrides: Partial<ProjectionLimitFailoverCandidate> = {},
): ProjectionLimitFailoverCandidate => ({
  id: ThreadId.make("thread:limited"),
  projectId: ProjectId.make("project:limited"),
  status: "failed",
  lastErrorClass: "usage_limit",
  usageLimitResetAt: "2026-10-20T15:00:00.000Z",
  latestRunId: RunId.make("run:limited"),
  latestRunCompletedAt: DateTime.makeUnsafe(NOW_MS - 1_000),
  updatedAt: DateTime.makeUnsafe(NOW_MS - 1_000),
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  snoozedUntil: null,
  providerInstanceId: id("codex-1"),
  modelSelection: { instanceId: id("codex-1"), model: "gpt-5.4" },
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make("thread:limited"),
  },
  latestRun: {
    id: RunId.make("run:limited"),
    providerInstanceId: id("codex-1"),
    modelSelection: { instanceId: id("codex-1"), model: "gpt-5.4" },
  },
  ...overrides,
});

const accounts = [
  provider("codex-1", [window(100)]),
  provider("codex-2", [window(40, { resetsAt: "2026-10-26T00:00:00.000Z" })]),
  provider("codex-3", [window(10, { resetsAt: "2026-10-22T00:00:00.000Z" })]),
];

describe("usage limit failover", () => {
  it("ranks open accounts by each strategy and breaks ties with the configured order", () => {
    assert.equal(pick(accounts, ["codex-1", "codex-2", "codex-3"]), "codex-2");
    assert.equal(pick(accounts, ["codex-3", "codex-2"]), "codex-3");
    assert.equal(pick(accounts, ["codex-2", "codex-3"], "earliest-reset"), "codex-3");
    assert.equal(pick(accounts, ["codex-2", "codex-3"], "most-remaining"), "codex-3");
    const tied = [
      provider("codex-1", [window(100)]),
      provider("codex-2", [window(30)]),
      provider("codex-3", [window(30)]),
    ];
    assert.equal(pick(tied, ["codex-3", "codex-2"], "most-remaining"), "codex-3");
    assert.equal(pick(tied, ["codex-3", "codex-2"], "earliest-reset"), "codex-3");
  });

  it("only rotates to listed, usable, open accounts of the same driver", () => {
    assert.isNull(pick(accounts, []), "an empty order rotates nowhere");
    assert.isNull(
      pick([accounts[0]!, provider("codex-disabled", [window(0)])], ["codex-disabled"]),
      "an account the project turned off is never a target",
    );
    assert.equal(pick(accounts, ["codex-3"]), "codex-3", "unlisted accounts never take part");
    for (const blocked of [
      provider("codex-2", [window(10)], { enabled: false }),
      provider("codex-2", [window(10)], { installed: false }),
      provider("codex-2", [window(10)], { availability: "unavailable" }),
      provider("codex-2", [window(10)], { status: "error" }),
      provider("codex-2", [window(10)], { auth: { status: "unauthenticated" } }),
      provider("codex-2", [window(10)], { driver: claude }),
      provider("codex-2", [window(10)], { models: [] }),
      provider("codex-2", [window(100, { kind: "session", id: "five_hour" }), window(10)]),
    ]) {
      assert.isNull(pick([accounts[0]!, blocked], ["codex-2"]), JSON.stringify(blocked));
    }
  });

  it("ignores money windows, treats unknown usage as a last resort and honors cooldowns", () => {
    const spend = provider("codex-2", [
      window(10),
      window(100, { id: "spend", kind: "monthly", unit: "USD", limit: 10 }),
    ]);
    assert.equal(usageLimitState(spend, NOW_MS), "open");
    const unknown = provider("codex-2", null);
    const probeFailed = provider("codex-3", [window(0)], {
      usageLimits: {
        checkedAt: "2026-10-20T12:00:00.000Z",
        windows: [window(0)],
        unavailable: { reason: "probeFailed" },
      },
    });
    const open = provider("codex-4", [window(90)]);
    assert.equal(usageLimitState(probeFailed, NOW_MS), "unknown");
    assert.equal(
      pick([accounts[0]!, unknown, probeFailed, open], ["codex-2", "codex-3", "codex-4"]),
      "codex-4",
    );
    assert.equal(pick([accounts[0]!, unknown, probeFailed], ["codex-3", "codex-2"]), "codex-3");
    // A window whose reset time passed is no longer limiting.
    assert.equal(
      usageLimitState(
        provider("codex-2", [window(100, { resetsAt: "2026-10-20T11:00:00.000Z" })]),
        NOW_MS,
      ),
      "open",
    );
    assert.equal(
      pick(accounts, ["codex-2", "codex-3"], "order", new Map([[id("codex-2"), NOW_MS + 1]])),
      "codex-3",
    );
    assert.equal(
      pick(accounts, ["codex-2", "codex-3"], "order", new Map([[id("codex-2"), NOW_MS]])),
      "codex-2",
      "an expired cooldown no longer blocks",
    );
  });

  it("keeps the model when offered and otherwise falls back to the account default", () => {
    const source = { instanceId: id("codex-1"), model: "gpt-5.4", options: [] };
    assert.deepEqual(failoverModelSelection(source, accounts[1]!), {
      instanceId: id("codex-2"),
      model: "gpt-5.4",
      options: [],
    });
    const aliased = provider("codex-2", [window(0)], {
      models: [
        {
          slug: "gpt-5.4-new",
          name: "GPT",
          aliases: ["gpt-5.4"],
          isCustom: false,
          capabilities: null,
        },
      ],
    });
    assert.equal(failoverModelSelection(source, aliased)?.model, "gpt-5.4-new");
    const other = provider("codex-2", [window(0)], {
      models: [
        { slug: "o9", name: "O9", isCustom: false, capabilities: null },
        { slug: "o10", name: "O10", isCustom: false, isDefault: true, capabilities: null },
      ],
    });
    assert.deepEqual(failoverModelSelection(source, other), {
      instanceId: id("codex-2"),
      model: "o10",
    });
  });

  it("builds one stable continuation command per limited run", () => {
    const first = planLimitFailover({
      thread: thread(),
      rotation: rotation(["codex-2"]),
      providers: accounts,
      cooldowns: new Map(),
      nowMs: NOW_MS,
      enabledForThread: () => true,
    });
    const again = planLimitFailover({
      thread: thread(),
      rotation: rotation(["codex-2"]),
      providers: accounts,
      cooldowns: new Map(),
      nowMs: NOW_MS + 5_000,
      enabledForThread: () => true,
    });
    assert.deepEqual(first, again);
    assert.equal(first.type, "dispatch");
    if (first.type !== "dispatch") return;
    assert.equal(first.command.commandId, "limit-failover:thread:limited:run:limited");
    assert.equal(String(first.command.messageId), first.command.commandId);
    assert.isTrue(isLimitFailoverMessageId(first.command.messageId));
    assert.equal(first.command.manualContinuationOfRunId, "run:limited");
    assert.deepEqual(first.command.modelSelection, { instanceId: id("codex-2"), model: "gpt-5.4" });
    assert.deepEqual(first.command.dispatchMode, { type: "start_immediately" });
    assert.equal(first.command.usageLimitContinuationOfRunId, undefined);
  });

  it("leaves threads alone that rotation must not move", () => {
    const plan = (candidate: ProjectionLimitFailoverCandidate, settings = rotation(["codex-2"])) =>
      planLimitFailover({
        thread: candidate,
        rotation: settings,
        providers: accounts,
        cooldowns: new Map(),
        nowMs: NOW_MS,
        enabledForThread: () => true,
      });
    assert.deepEqual(plan(thread(), {}), { type: "skip", reason: "rotation-off" });
    assert.deepEqual(
      plan(thread(), { [codex]: { enabled: false, strategy: "order", order: [id("codex-2")] } }),
      {
        type: "skip",
        reason: "rotation-off",
      },
    );
    assert.deepEqual(plan(thread({ providerInstanceId: id("codex-3") })), {
      type: "skip",
      reason: "manually-switched",
    });
    assert.deepEqual(plan(thread({ snoozedUntil: DateTime.makeUnsafe(NOW_MS + 60_000) })), {
      type: "skip",
      reason: "snoozed",
    });
    assert.equal(plan(thread({ snoozedUntil: DateTime.makeUnsafe(NOW_MS - 1) })).type, "dispatch");
    assert.deepEqual(
      plan(
        thread({
          lineage: {
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("parent"),
          },
        }),
      ),
      { type: "skip", reason: "subagent" },
    );
    assert.deepEqual(plan(thread(), rotation(["codex-1"])), { type: "skip", reason: "no-account" });
  });

  it("keeps a limited account out until its reset, or a fixed wait without one", () => {
    assert.equal(limitCooldownUntilMs(thread()), Date.parse("2026-10-20T15:00:00.000Z"));
    assert.equal(
      limitCooldownUntilMs(thread({ usageLimitResetAt: null })),
      NOW_MS - 1_000 + LIMIT_FAILOVER_COOLDOWN_MS,
    );
  });
});
