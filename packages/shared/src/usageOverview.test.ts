import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  collectAutomaticExtras,
  collectUsageOverview,
  dueExtraReminders,
  forecastWindow,
  formatCountdown,
  formatRunway,
  isExtraEndingSoon,
  manualExtraCards,
  runwayDays,
  sortExtras,
} from "./usageOverview.ts";
import { collectLimitAccounts } from "./usageLimits.ts";

const now = Date.parse("2026-10-20T12:00:00.000Z");
const checkedAt = "2026-10-20T11:58:00.000Z";
const at = (hoursFromNow: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(now + hoursFromNow * 3_600_000));

const session = (usedPercent: number, resetInHours: number): ServerProviderUsageWindow => ({
  id: "primary",
  kind: "session",
  label: "5 hours",
  usedPercent,
  windowDurationMins: 300,
  resetsAt: at(resetInHours),
});
const weekly = (usedPercent: number, resetInHours: number): ServerProviderUsageWindow => ({
  id: "secondary",
  kind: "weekly",
  label: "Week",
  usedPercent,
  windowDurationMins: 7 * 24 * 60,
  resetsAt: at(resetInHours),
});

function codex(name: string, windows: ServerProviderUsageWindow[]): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(name.toLowerCase().replace(/\s+/g, "-")),
    driver: ProviderDriverKind.make("codex"),
    displayName: name,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: {
      status: "authenticated",
      email: `${name.replace(/\s+/g, "").toLowerCase()}@example.com`,
    },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt, windows },
  };
}

function presentations(
  providers: ServerProvider[],
  sources: ReadonlyArray<Record<string, unknown>> = [],
) {
  return new Map([
    [
      EnvironmentId.make("env-a"),
      {
        entry: { target: { label: "Laptop" } },
        serverConfig: { providers, usageLimitSources: sources as never },
      },
    ],
  ]);
}

const source = (
  kind: string,
  label: string,
  driver: string,
  usageLimits: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  id: UsageLimitSourceId.make(label.toLowerCase()),
  kind,
  label,
  checkedAt,
  accounts: [{ id: label, driver: ProviderDriverKind.make(driver), ...extra, usageLimits }],
});

describe("collectUsageOverview", () => {
  it("puts subscription quotas under Frontier and tool sources under Tools & money", () => {
    const overview = collectUsageOverview(
      presentations(
        [codex("Codex 1", [session(20, 3)])],
        [
          // A CLIProxy hub reports Claude subscriptions: frontier, not a tool.
          source(
            "cliproxy",
            "Hub",
            "claudeAgent",
            { checkedAt, windows: [session(10, 2)] },
            { email: "claude@example.com" },
          ),
          source("fal", "fal", "fal", {
            checkedAt,
            windows: [
              {
                id: "balance",
                kind: "other",
                label: "Balance",
                usedPercent: 0,
                remaining: 12.4,
                unit: "USD",
              },
            ],
            spend: { currency: "USD", day: 0.8, month: 7.1 },
          }),
          source("elevenlabs", "ElevenLabs", "elevenlabs", {
            checkedAt,
            windows: [
              {
                id: "characters",
                kind: "monthly",
                label: "Characters",
                usedPercent: 60,
                remaining: 40_000,
                limit: 100_000,
                unit: "characters",
                resetsAt: at(240),
              },
            ],
          }),
        ],
      ),
      now,
    );
    expect(overview.frontier.map((family) => [family.driver, family.rows.length])).toEqual([
      ["codex", 1],
      ["claudeAgent", 1],
    ]);
    expect(overview.tools.map((row) => row.lines.map((line) => line.text))).toEqual([
      ["Characters: 40,000 of 100,000 left"],
      ["$12.40 left"],
    ]);
    expect(overview.tools[1]?.lines[0]?.spend).toBe("today $0.80 · month $7.10");
  });

  it("binds each account to its tightest window and sorts a family by the earliest reset", () => {
    const overview = collectUsageOverview(
      presentations([
        codex("Codex 1", [session(10, 4), weekly(95, 100)]),
        codex("Codex 2", [session(30, 1), weekly(20, 50)]),
        codex("Codex 3", [session(5, 2), weekly(100, 30)]),
      ]),
      now,
    );
    const rows = overview.frontier[0]!.rows;
    expect(rows.map((row) => row.account.displayName)).toEqual(["Codex 2", "Codex 3", "Codex 1"]);
    expect(rows.map((row) => [row.binding.label, row.binding.remainingPercent])).toEqual([
      ["5 hours", 70],
      ["Week", 0],
      ["Week", 5],
    ]);
    expect(rows[1]!.tone).toBe("out");
  });

  it("suggests leftover that resets soon before the account with most headroom, never an empty one", () => {
    const soon = collectUsageOverview(
      presentations([
        codex("Codex 1", [weekly(10, 120)]),
        codex("Codex 2", [weekly(60, 5)]),
        codex("Codex 3", [weekly(100, 1)]),
      ]),
      now,
    ).frontier[0]!.recommendation;
    expect(soon).toMatchObject({ reason: "expiresSoon", remainingPercent: 40 });
    expect(soon?.accountKey).toContain("codex-2");

    const headroom = collectUsageOverview(
      presentations([codex("Codex 1", [weekly(10, 120)]), codex("Codex 2", [weekly(60, 90)])]),
      now,
    ).frontier[0]!.recommendation;
    expect(headroom).toMatchObject({ reason: "mostHeadroom", remainingPercent: 90 });
    expect(headroom?.accountKey).toContain("codex-1");

    expect(
      collectUsageOverview(presentations([codex("Codex 1", [weekly(10, 120)])]), now).frontier[0]!
        .recommendation,
    ).toBeNull();
  });

  it("keeps unreadable sources visible as notices", () => {
    const overview = collectUsageOverview(
      presentations(
        [],
        [
          {
            ...source("fal", "fal", "fal", { checkedAt, windows: [] }),
            accounts: [],
            error: "Key refused.",
          },
        ],
      ),
      now,
    );
    expect(overview.tools).toEqual([]);
    expect(overview.notices).toEqual(["fal: Key refused."]);
  });

  it("greys numbers older than half an hour", () => {
    const old = codex("Codex 1", [session(10, 3)]);
    const overview = collectUsageOverview(
      presentations([
        { ...old, usageLimits: { checkedAt: at(-1), windows: old.usageLimits!.windows } },
      ]),
      now,
    );
    expect(overview.frontier[0]!.rows[0]!.stale).toBe(true);
  });
});

describe("forecastWindow", () => {
  it("judges by pace, not the raw percentage", () => {
    // 90 % used with 10 minutes left of five hours: the reset comes first.
    expect(forecastWindow(session(90, 1 / 6), now)).toEqual({ kind: "lasts" });
    // 80 % used one hour in: empty in 15 minutes, long before the reset.
    const fast = forecastWindow(session(80, 4), now);
    expect(fast).toEqual({ kind: "runsOut", at: now + 15 * 60_000 });
  });

  it("stays quiet early in a window, for estimates and without a clock", () => {
    expect(forecastWindow(session(50, 4.9), now)).toBeNull();
    expect(forecastWindow({ ...session(50, 2), estimated: true }, now)).toBeNull();
    expect(forecastWindow({ ...session(50, 2), windowDurationMins: undefined }, now)).toBeNull();
  });
});

describe("money", () => {
  it("projects the balance from this month's average daily spend", () => {
    // Twenty days into October at noon: 19.5 days elapsed, $39 spent, $2 a day.
    expect(runwayDays(18, 39, now)).toBeCloseTo(9);
    expect(runwayDays(18, 0, now)).toBeNull();
    expect(runwayDays(18, undefined, now)).toBeNull();
    expect(formatRunway(9.4)).toBe("lasts ~9 days at this pace");
    expect(formatRunway(1.2)).toBe("lasts ~1 day at this pace");
    expect(formatRunway(0.4)).toBe("runs out within a day at this pace");
  });

  it("turns a balance amber when it lasts under three days", () => {
    const overview = collectUsageOverview(
      presentations(
        [],
        [
          source("deepseek", "DeepSeek", "deepseek", {
            checkedAt,
            windows: [
              {
                id: "balance-CNY",
                kind: "other",
                label: "Balance",
                usedPercent: 0,
                remaining: 10,
                unit: "CNY",
                spend: { month: 97.5 },
              },
            ],
          }),
        ],
      ),
      now,
    );
    expect(overview.tools[0]).toMatchObject({ tone: "warn" });
    expect(overview.tools[0]!.lines[0]!.text).toBe("CN¥10.00 left");
  });

  it("formats countdowns", () => {
    expect(formatCountdown(now + 134 * 60_000, now)).toBe("in 2h 14m");
    expect(formatCountdown(now - 1, now)).toBe("now");
  });
});

describe("extras", () => {
  const manual = manualExtraCards({
    later: { service: "Higgsfield", title: "Nano Banana unlimited", expiresAt: at(24 * 10) },
    soon: { service: "Higgsfield", title: "AI Influencer free", remaining: 4, expiresAt: at(30) },
    ended: { service: "Canva", title: "Magic Studio trial", expiresAt: at(-5) },
  });

  it("orders by end date with ended perks last and badges the ones ending within three days", () => {
    const codexAccounts = collectLimitAccounts(
      presentations([
        {
          ...codex("Codex 1", [session(10, 3)]),
          usageLimits: {
            checkedAt,
            windows: [session(10, 3)],
            resetCredits: { availableCount: 2, nextExpiresAt: at(2) },
          },
        },
      ]),
    );
    const automatic = collectAutomaticExtras(codexAccounts, (account) => ({
      service: "Codex",
      name: account.displayName ?? "",
    }));
    const sorted = sortExtras([...manual, ...automatic], now);
    expect(sorted.map((card) => card.title)).toEqual([
      "Banked limit resets",
      "AI Influencer free",
      "Nano Banana unlimited",
      "Magic Studio trial",
    ]);
    expect(sorted.filter((card) => isExtraEndingSoon(card, now)).length).toBe(2);
    expect(automatic[0]).toMatchObject({ remaining: 2, detail: "Codex 1", origin: "automatic" });
  });

  it("reminds three days and one day before the end, once each", () => {
    const due = dueExtraReminders(manual, now, new Set());
    expect(due.map((reminder) => [reminder.card.title, reminder.threshold])).toEqual([
      ["AI Influencer free", "3d"],
    ]);
    const delivered = new Set(due.map((reminder) => reminder.id));
    expect(dueExtraReminders(manual, now, delivered)).toEqual([]);
    const dayBefore = now + 7 * 3_600_000;
    expect(
      dueExtraReminders(manual, dayBefore, delivered).map((reminder) => reminder.threshold),
    ).toEqual(["1d"]);
  });
});
