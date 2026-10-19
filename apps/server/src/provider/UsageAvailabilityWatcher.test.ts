import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Stream from "effect/Stream";

import * as ProviderRegistry from "./ProviderRegistry.ts";
import { diffUsage, make, type UsageBaseline, UsageBaselines } from "./UsageAvailabilityWatcher.ts";

const NOW_MS = Date.parse("2026-10-20T12:00:00.000Z");
const instanceId = ProviderInstanceId.make("codex-2");
const WEEKLY_RESET = "2026-10-25T00:00:00.000Z";

const window = (
  usedPercent: number,
  overrides: Partial<ServerProviderUsageWindow> = {},
): ServerProviderUsageWindow => ({
  id: "weekly",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  resetsAt: WEEKLY_RESET,
  ...overrides,
});

const limits = (
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  overrides: Partial<ServerProviderUsageLimits> = {},
): ServerProviderUsageLimits => ({
  checkedAt: "2026-10-20T12:00:00.000Z",
  windows: [...windows],
  credentialFingerprint: "account-a",
  ...overrides,
});

/** Feeds reports through diffUsage the way the watcher does and collects the alerts. */
const replay = (reports: ReadonlyArray<readonly [number, ServerProviderUsageLimits]>) => {
  let baseline: UsageBaseline | undefined;
  const alerts: Array<string> = [];
  for (const [nowMs, report] of reports) {
    const result = diffUsage({ instanceId, baseline, limits: report, nowMs });
    if (result === null) continue;
    baseline = result.baseline;
    if (result.alert !== null) alerts.push(result.alert.kind);
  }
  return alerts;
};

describe("diffUsage", () => {
  it("stays quiet for the first report, another account and failed probes", () => {
    assert.deepEqual(replay([[NOW_MS, limits([window(0)])]]), []);
    assert.deepEqual(
      replay([
        [NOW_MS, limits([window(100)])],
        [NOW_MS, limits([window(0)], { credentialFingerprint: "account-b" })],
      ]),
      [],
    );
    assert.isNull(
      diffUsage({
        instanceId,
        baseline: undefined,
        limits: limits([window(0)], { unavailable: { reason: "probeFailed" } }),
        nowMs: NOW_MS,
      }),
    );
    // An unavailable probe between two reports neither alerts nor moves the baseline.
    assert.deepEqual(
      replay([
        [NOW_MS, limits([window(100)])],
        [NOW_MS, limits([], { unavailable: { reason: "probeFailed" } })],
        [NOW_MS, limits([window(5)])],
      ]),
      ["available"],
    );
  });

  it("announces a limited account becoming available once per episode", () => {
    assert.deepEqual(
      replay([
        [NOW_MS, limits([window(100)])],
        [NOW_MS + 1, limits([window(99)])],
        [NOW_MS + 2, limits([window(100)])],
        [NOW_MS + 3, limits([window(99)])],
      ]),
      ["available"],
    );
    // A later limit with a new reset time is a new episode.
    assert.deepEqual(
      replay([
        [NOW_MS, limits([window(100)])],
        [NOW_MS + 1, limits([window(0)])],
        [NOW_MS + 2, limits([window(100, { resetsAt: "2026-11-01T00:00:00.000Z" })])],
        [NOW_MS + 3, limits([window(0, { resetsAt: "2026-11-01T00:00:00.000Z" })])],
      ]),
      ["available", "available"],
    );
  });

  it("detects early resets, earlier reset times and new reset credits", () => {
    assert.deepEqual(
      replay([
        [NOW_MS, limits([window(70)])],
        [NOW_MS + 60_000, limits([window(10)])],
      ]),
      ["early-reset"],
    );
    // The scheduled reset itself, or a small drop, is not early.
    assert.deepEqual(
      replay([
        [NOW_MS, limits([window(70, { resetsAt: "2026-10-20T12:03:00.000Z" })])],
        [NOW_MS + 60_000, limits([window(0, { resetsAt: "2026-10-27T12:00:00.000Z" })])],
      ]),
      [],
    );
    assert.deepEqual(
      replay([
        [NOW_MS, limits([window(70)])],
        [NOW_MS + 1, limits([window(55)])],
      ]),
      [],
    );
    assert.deepEqual(
      replay([
        [NOW_MS, limits([window(70)])],
        [NOW_MS + 1, limits([window(70, { resetsAt: "2026-10-24T22:00:00.000Z" })])],
        [NOW_MS + 2, limits([window(70, { resetsAt: "2026-10-24T21:30:00.000Z" })])],
      ]),
      ["reset-moved-earlier"],
    );
    assert.deepEqual(
      replay([
        [NOW_MS, limits([window(70)], { resetCredits: { availableCount: 0 } })],
        [
          NOW_MS + 1,
          limits([window(70)], { resetCredits: { availableCount: 1, nextCreditId: "c1" } }),
        ],
        [
          NOW_MS + 2,
          limits([window(70)], { resetCredits: { availableCount: 1, nextCreditId: "c1" } }),
        ],
      ]),
      ["credit-added"],
    );
  });

  it("ignores money windows", () => {
    const spend = (usedPercent: number) =>
      window(usedPercent, { id: "spend", kind: "monthly", unit: "USD", limit: 10 });
    assert.deepEqual(
      replay([
        [NOW_MS, limits([window(20), spend(100)])],
        [NOW_MS + 1, limits([window(20), spend(0)])],
      ]),
      [],
    );
  });
});

const provider = (usageLimits: ServerProviderUsageLimits): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-20T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits,
});

describe("UsageAvailabilityWatcher", () => {
  it.effect("compares against the baseline saved before a restart and never repeats an alert", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      const baselines = KeyValueStore.toSchemaStore(store, UsageBaselines);
      yield* baselines.set("baselines", {
        [instanceId]: {
          fingerprint: "account-a",
          windows: [{ id: "weekly", label: "Weekly", usedPercent: 100, resetsAt: WEEKLY_RESET }],
          resetCredits: 2,
          recentAlertIds: [],
        },
      });
      const available = provider(limits([window(0)], { resetCredits: { availableCount: 2 } }));
      const credited = provider(limits([window(0)], { resetCredits: { availableCount: 3 } }));
      const start = (changes: ReadonlyArray<ReadonlyArray<ServerProvider>>) =>
        make.pipe(
          Effect.provide(
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([available]),
              streamChanges: Stream.fromIterable(changes),
            }),
          ),
        );
      const alertOf = (kind: string) =>
        Effect.flatMap(start(kind === "available" ? [] : [[credited]]), (watcher) =>
          watcher.decorateStream(Stream.succeed([available])).pipe(
            Stream.map((providers) => providers[0]?.usageAvailability),
            Stream.filter((alert) => alert?.kind === kind),
            Stream.runHead,
            Effect.map((alert) => (alert._tag === "Some" ? alert.value : undefined)),
          ),
        );
      const first = yield* Effect.scoped(alertOf("available"));
      assert.equal(first?.windowLabel, "Weekly");
      const saved = yield* baselines.get("baselines");
      assert.equal(
        saved._tag === "Some" ? saved.value[instanceId]?.alert?.id : undefined,
        first?.id,
      );
      // Reset credits are only counted: the restarted watcher reads the saved
      // baseline, stays quiet for the unchanged report, then notices one more credit.
      const second = yield* Effect.scoped(alertOf("credit-added"));
      assert.isDefined(second);
      const after = yield* baselines.get("baselines");
      assert.deepEqual(after._tag === "Some" ? after.value[instanceId]?.recentAlertIds : [], [
        first!.id,
        second!.id,
      ]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );
});
