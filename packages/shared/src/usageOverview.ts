import type { ServerProvider, ServerProviderUsageWindow, UsageExtra } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  collectExternalUsageLinks,
  collectLimitAccounts,
  collectLimitNotices,
  formatDuration,
  formatMoney,
  isAmountWindow,
  isMoneyWindow,
  remainingPercent,
  type LimitAccount,
  type LimitPresentations,
} from "./usageLimits.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A pace read this early in a window is noise, so forecasts wait for 3 % of it to pass. */
export const MIN_FORECAST_ELAPSED_SHARE = 0.03;
/** Older numbers are greyed: limits refresh every few minutes while a server is connected. */
export const USAGE_STALE_AFTER_MS = 30 * MINUTE;
/** Quota left in a window that resets within this long is lost unless it is used now. */
export const USE_NOW_RESET_WITHIN_MS = 24 * HOUR;
/** Leftovers smaller than this are not worth steering work to. */
const USE_NOW_MIN_REMAINING_PERCENT = 5;
/** Below this many days of balance a money row turns amber. */
const LOW_RUNWAY_DAYS = 3;
/** Extras ending within this long count as ending soon and get the badge. */
export const EXTRA_SOON_MS = 3 * DAY;
/** Reminders fire once per threshold, tightest first: three days and one day before the end. */
export const EXTRA_REMINDER_THRESHOLDS = [
  { id: "1d", ms: DAY },
  { id: "3d", ms: 3 * DAY },
] as const;

/**
 * `ok` and `warn` come from the pace, never from the raw percentage: 90 % used an hour before the
 * reset is fine. `unknown` means there is no clock to judge by yet.
 */
export type UsageTone = "ok" | "warn" | "out" | "unknown";

export type UsageForecast =
  | { readonly kind: "lasts" }
  | { readonly kind: "runsOut"; readonly at: number };

export interface OverviewWindow {
  readonly id: string;
  readonly label: string;
  readonly remainingPercent: number;
  readonly resetsAt: number | null;
  readonly estimated: boolean;
  readonly forecast: UsageForecast | null;
}

export interface FrontierRow {
  readonly account: LimitAccount;
  /** The tightest window: what actually stops work on this account. */
  readonly binding: OverviewWindow;
  readonly others: readonly OverviewWindow[];
  readonly forecast: UsageForecast | null;
  readonly tone: UsageTone;
  readonly checkedAt: number;
  readonly stale: boolean;
}

export interface UsageRecommendation {
  readonly accountKey: string;
  /** `expiresSoon`: the leftover resets away soon. `mostHeadroom`: nothing expires, most is left. */
  readonly reason: "expiresSoon" | "mostHeadroom";
  readonly remainingPercent: number;
  readonly resetsAt: number | null;
}

export interface FrontierFamily {
  readonly driver: ServerProvider["driver"];
  readonly rows: readonly FrontierRow[];
  readonly recommendation: UsageRecommendation | null;
}

export interface ToolLine {
  readonly id: string;
  readonly text: string;
  /** Share left (0–1) when the allowance is known, for the bar. */
  readonly fraction: number | null;
  readonly resetsAt: number | null;
  readonly estimated: boolean;
  readonly spend: string | null;
  /** Days the balance lasts at this month's average daily spend. */
  readonly runwayDays: number | null;
  readonly forecast: UsageForecast | null;
}

export interface ToolRow {
  readonly account: LimitAccount;
  readonly lines: readonly ToolLine[];
  readonly tone: UsageTone;
  readonly checkedAt: number;
  readonly stale: boolean;
}

export interface UsageOverview {
  readonly frontier: readonly FrontierFamily[];
  readonly tools: readonly ToolRow[];
  /** Sources and accounts that report nothing usable; shown so nothing disappears silently. */
  readonly notices: readonly string[];
  readonly links: ReturnType<typeof collectExternalUsageLinks>;
}

const FAMILY_ORDER = ["codex", "claudeAgent", "antigravity", "opencode", "cursor", "grok"];

function familyRank(driver: string): number {
  const index = FAMILY_ORDER.indexOf(driver);
  return index === -1 ? FAMILY_ORDER.length : index;
}

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/**
 * Projects the current rate to the reset: the window started `windowDurationMins` before
 * `resetsAt`. Estimated windows have no trustworthy clock, so they get no forecast.
 */
export function forecastWindow(
  window: ServerProviderUsageWindow,
  now: number,
): UsageForecast | null {
  const resetsAt = resetMillis(window);
  if (resetsAt === null || resetsAt <= now || window.estimated) return null;
  if (window.windowDurationMins === undefined || window.windowDurationMins <= 0) return null;
  const length = window.windowDurationMins * MINUTE;
  const elapsed = now - (resetsAt - length);
  if (elapsed < length * MIN_FORECAST_ELAPSED_SHARE) return null;
  const used = Math.max(0, Math.min(100, window.usedPercent));
  if (used >= 100) return null;
  if (used === 0) return { kind: "lasts" };
  const emptyAt = now + ((100 - used) * elapsed) / used;
  return emptyAt < resetsAt ? { kind: "runsOut", at: emptyAt } : { kind: "lasts" };
}

function overviewWindow(window: ServerProviderUsageWindow, now: number): OverviewWindow {
  return {
    id: window.id,
    label: window.label,
    remainingPercent: remainingPercent(window),
    resetsAt: resetMillis(window),
    estimated: window.estimated === true,
    forecast: forecastWindow(window, now),
  };
}

/** The earliest projected run-out wins; otherwise any window that lasts. */
function combinedForecast(windows: readonly OverviewWindow[]): UsageForecast | null {
  let lasts = false;
  let runsOut: number | null = null;
  for (const { forecast } of windows) {
    if (forecast?.kind === "runsOut") runsOut = Math.min(runsOut ?? forecast.at, forecast.at);
    if (forecast?.kind === "lasts") lasts = true;
  }
  if (runsOut !== null) return { kind: "runsOut", at: runsOut };
  return lasts ? { kind: "lasts" } : null;
}

function toneOf(remaining: number, forecast: UsageForecast | null): UsageTone {
  if (remaining <= 0) return "out";
  if (forecast?.kind === "runsOut") return "warn";
  if (forecast?.kind === "lasts") return "ok";
  return "unknown";
}

export function accountSortName(account: LimitAccount): string {
  return (account.displayName ?? account.email ?? account.sourceLabel ?? account.key).toLowerCase();
}

function checkedAtOf(account: LimitAccount): number {
  const at = Date.parse(account.limits.checkedAt);
  return Number.isFinite(at) ? at : 0;
}

function frontierRow(
  account: LimitAccount,
  windows: readonly ServerProviderUsageWindow[],
  now: number,
): FrontierRow {
  const shown = windows.map((window) => overviewWindow(window, now));
  // Tightest first; on a tie the window that stays blocked longer binds.
  const [binding, ...others] = [...shown].sort(
    (left, right) =>
      left.remainingPercent - right.remainingPercent ||
      (right.resetsAt ?? Number.POSITIVE_INFINITY) - (left.resetsAt ?? Number.POSITIVE_INFINITY),
  );
  const forecast = combinedForecast(shown);
  const checkedAt = checkedAtOf(account);
  return {
    account,
    binding: binding!,
    others,
    forecast,
    tone: toneOf(binding!.remainingPercent, forecast),
    checkedAt,
    stale: now - checkedAt > USAGE_STALE_AFTER_MS,
  };
}

/** Earliest reset first, then name, so the account that frees up next leads its family. */
export function compareFrontierRows(left: FrontierRow, right: FrontierRow): number {
  return (
    (left.binding.resetsAt ?? Number.POSITIVE_INFINITY) -
      (right.binding.resetsAt ?? Number.POSITIVE_INFINITY) ||
    accountSortName(left.account).localeCompare(accountSortName(right.account)) ||
    left.account.key.localeCompare(right.account.key)
  );
}

/**
 * Leftover that resets away within a day goes first, since it is lost otherwise; then the most
 * headroom. Empty accounts are never suggested, and a lone account needs no suggestion.
 */
export function recommendAccount(
  rows: readonly FrontierRow[],
  now: number,
): UsageRecommendation | null {
  if (rows.length < 2) return null;
  const candidates = rows.filter((row) => row.binding.remainingPercent > 0);
  const expiring = candidates
    .filter(
      (row) =>
        row.binding.remainingPercent >= USE_NOW_MIN_REMAINING_PERCENT &&
        row.binding.resetsAt !== null &&
        row.binding.resetsAt > now &&
        row.binding.resetsAt - now <= USE_NOW_RESET_WITHIN_MS,
    )
    .sort((left, right) => left.binding.resetsAt! - right.binding.resetsAt!);
  const pick =
    expiring[0] ??
    [...candidates].sort(
      (left, right) =>
        right.binding.remainingPercent - left.binding.remainingPercent ||
        compareFrontierRows(left, right),
    )[0];
  if (!pick) return null;
  return {
    accountKey: pick.account.key,
    reason: expiring[0] ? "expiresSoon" : "mostHeadroom",
    remainingPercent: pick.binding.remainingPercent,
    resetsAt: pick.binding.resetsAt,
  };
}

function startOfUtcMonth(now: number): number {
  const { year, month } = DateTime.toPartsUtc(DateTime.makeUnsafe(now));
  return Date.UTC(year, month - 1, 1);
}

/** Days a balance lasts at this month's average daily spend; null without spend to go by. */
export function runwayDays(
  remaining: number,
  monthSpend: number | undefined,
  now: number,
): number | null {
  if (monthSpend === undefined || monthSpend <= 0) return null;
  const elapsedDays = Math.max(1, (now - startOfUtcMonth(now)) / DAY);
  return remaining / (monthSpend / elapsedDays);
}

export function formatRunway(days: number): string {
  if (days < 1) return "runs out within a day at this pace";
  const rounded = Math.floor(days);
  return `lasts ~${rounded} ${rounded === 1 ? "day" : "days"} at this pace`;
}

type SpendPeriods = {
  readonly day?: number | undefined;
  readonly week?: number | undefined;
  readonly month?: number | undefined;
};

function spendText(spend: SpendPeriods, currency: string): string | null {
  const parts = (
    [
      ["today", spend.day],
      ["month", spend.month],
    ] as const
  ).flatMap(([period, amount]) =>
    amount === undefined ? [] : [`${period} ${formatMoney(amount, currency)}`],
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function toolLine(
  window: ServerProviderUsageWindow,
  accountSpend: LimitAccount["limits"]["spend"],
  now: number,
): ToolLine {
  const resetsAt = resetMillis(window);
  const estimated = window.estimated === true;
  if (isMoneyWindow(window) && window.remaining !== undefined && window.unit !== undefined) {
    const currency = window.unit;
    const spend = window.spend ?? (accountSpend?.currency === currency ? accountSpend : undefined);
    const left = formatMoney(window.remaining, currency);
    return {
      id: window.id,
      text:
        window.limit === undefined
          ? `${left} left`
          : `${left} of ${formatMoney(window.limit, currency)} left`,
      fraction:
        window.limit !== undefined && window.limit > 0 ? window.remaining / window.limit : null,
      resetsAt,
      estimated,
      spend: spend ? spendText(spend, currency) : null,
      runwayDays: runwayDays(window.remaining, spend?.month, now),
      forecast: null,
    };
  }
  if (window.remaining !== undefined && window.unit !== undefined) {
    const unit = capitalize(window.unit);
    return {
      id: window.id,
      text:
        window.limit === undefined
          ? `${unit}: ${formatCount(window.remaining)} left`
          : `${unit}: ${formatCount(window.remaining)} of ${formatCount(window.limit)} left`,
      fraction:
        window.limit !== undefined && window.limit > 0 ? window.remaining / window.limit : null,
      resetsAt,
      estimated,
      spend: null,
      runwayDays: null,
      forecast: forecastWindow(window, now),
    };
  }
  const remaining = remainingPercent(window);
  return {
    id: window.id,
    text: `${window.label}: ${remaining}% left`,
    fraction: remaining / 100,
    resetsAt,
    estimated,
    spend: null,
    runwayDays: null,
    forecast: forecastWindow(window, now),
  };
}

function toolTone(lines: readonly ToolLine[]): UsageTone {
  if (lines.some((line) => line.fraction !== null && line.fraction <= 0)) return "out";
  if (
    lines.some(
      (line) =>
        line.forecast?.kind === "runsOut" ||
        (line.runwayDays !== null && line.runwayDays < LOW_RUNWAY_DAYS),
    )
  ) {
    return "warn";
  }
  if (lines.some((line) => line.forecast?.kind === "lasts" || line.runwayDays !== null)) {
    return "ok";
  }
  return "unknown";
}

function toolRow(
  account: LimitAccount,
  windows: readonly ServerProviderUsageWindow[],
  now: number,
) {
  const spend = account.limits.spend;
  const lines = windows.map((window) => toolLine(window, spend, now));
  // Spend that no window carries, such as an OpenRouter key without a limit.
  if (spend && !lines.some((line) => line.spend !== null)) {
    const text = spendText(spend, spend.currency);
    if (text) {
      lines.push({
        id: "spend",
        text: `Spent ${text}`,
        fraction: null,
        resetsAt: null,
        estimated: false,
        spend: null,
        runwayDays: null,
        forecast: null,
      });
    }
  }
  const checkedAt = checkedAtOf(account);
  return {
    account,
    lines,
    tone: toolTone(lines),
    checkedAt,
    stale: now - checkedAt > USAGE_STALE_AFTER_MS,
  } satisfies ToolRow;
}

/**
 * Drivers reported by tool and money sources (fal, Higgsfield, …). A CLIProxy hub reports Codex
 * and Claude subscriptions, which belong with the frontier accounts they are.
 */
function toolDrivers(presentations: LimitPresentations): ReadonlySet<string> {
  const drivers = new Set<string>();
  for (const presentation of presentations.values()) {
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.kind === "cliproxy") continue;
      for (const account of source.accounts) drivers.add(String(account.driver));
    }
  }
  return drivers;
}

/**
 * Frontier: subscription quotas of coding-agent accounts, grouped by family. Tools & money:
 * balances, credits and spend, plus any quota a tool source reports.
 */
export function collectUsageOverview(
  presentations: LimitPresentations,
  now: number,
): UsageOverview {
  const accounts = collectLimitAccounts(presentations);
  const tools = toolDrivers(presentations);
  const families = new Map<ServerProvider["driver"], FrontierRow[]>();
  const toolRows: ToolRow[] = [];
  for (const account of accounts) {
    const isTool = tools.has(String(account.driver));
    const quota = account.limits.windows.filter((window) => !isAmountWindow(window));
    const amounts = account.limits.windows.filter(isAmountWindow);
    if (!isTool && quota.length > 0) {
      const row = frontierRow(account, quota, now);
      const list = families.get(account.driver);
      if (list) list.push(row);
      else families.set(account.driver, [row]);
    }
    // Money on a frontier account (extra usage, credits) still belongs under money.
    const toolWindows = isTool ? account.limits.windows : amounts;
    if (toolWindows.length > 0 || (account.limits.spend && (isTool || quota.length === 0))) {
      const row = toolRow(account, toolWindows, now);
      if (row.lines.length > 0) toolRows.push(row);
    }
  }
  const frontier = [...families]
    .map(([driver, rows]) => {
      const sorted = [...rows].sort(compareFrontierRows);
      return { driver, rows: sorted, recommendation: recommendAccount(sorted, now) };
    })
    .sort(
      (left, right) =>
        familyRank(String(left.driver)) - familyRank(String(right.driver)) ||
        String(left.driver).localeCompare(String(right.driver)),
    );
  return {
    frontier,
    tools: [...toolRows].sort(
      (left, right) =>
        accountSortName(left.account).localeCompare(accountSortName(right.account)) ||
        left.account.key.localeCompare(right.account.key),
    ),
    notices: collectLimitNotices(presentations),
    links: collectExternalUsageLinks(presentations),
  };
}

/** "in 2h 14m", "in 3d 3h"; past times read as "now". */
export function formatCountdown(at: number, now: number): string {
  return at <= now ? "now" : `in ${formatDuration(at - now)}`;
}

export interface UsageExtraCard {
  readonly key: string;
  readonly origin: "automatic" | "manual";
  readonly service: string;
  readonly title: string;
  readonly remaining: number | null;
  readonly expiresAt: number | null;
  /** Where the perk comes from, such as the account it belongs to. */
  readonly detail: string | null;
  /** The settings key of a manual perk, for removing it. */
  readonly manualId: string | null;
  /** The account a banked reset belongs to, for redeeming it. */
  readonly account: LimitAccount | null;
}

/** Banked Codex resets: each account with credits becomes one card, ending with its next credit. */
export function collectAutomaticExtras(
  accounts: readonly LimitAccount[],
  label: (account: LimitAccount) => { readonly service: string; readonly name: string },
): UsageExtraCard[] {
  return accounts.flatMap((account) => {
    const credits = account.limits.resetCredits;
    if (!credits || credits.availableCount <= 0) return [];
    const expiresAt = credits.nextExpiresAt ? Date.parse(credits.nextExpiresAt) : Number.NaN;
    const { service, name } = label(account);
    return [
      {
        key: `reset-credits:${account.key}`,
        origin: "automatic" as const,
        service,
        title: credits.availableCount === 1 ? "Banked limit reset" : "Banked limit resets",
        remaining: credits.availableCount,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
        detail: name,
        manualId: null,
        account,
      },
    ];
  });
}

export function manualExtraCards(extras: Readonly<Record<string, UsageExtra>>): UsageExtraCard[] {
  return Object.entries(extras).map(([id, extra]) => {
    const expiresAt = Date.parse(extra.expiresAt);
    return {
      key: `manual:${id}`,
      origin: "manual" as const,
      service: extra.service,
      title: extra.title,
      remaining: extra.remaining ?? null,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
      detail: null,
      manualId: id,
      account: null,
    };
  });
}

/** Ending soonest first, undated next, ended ones last so they can still be cleaned up. */
export function sortExtras(cards: readonly UsageExtraCard[], now: number): UsageExtraCard[] {
  const rank = (card: UsageExtraCard) =>
    card.expiresAt === null ? 1 : card.expiresAt > now ? 0 : 2;
  return [...cards].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      (rank(left) === 2
        ? right.expiresAt! - left.expiresAt!
        : (left.expiresAt ?? 0) - (right.expiresAt ?? 0)) ||
      left.service.localeCompare(right.service) ||
      left.key.localeCompare(right.key),
  );
}

export function isExtraEndingSoon(card: UsageExtraCard, now: number): boolean {
  return card.expiresAt !== null && card.expiresAt > now && card.expiresAt - now <= EXTRA_SOON_MS;
}

export interface UsageExtraReminder {
  /** Stable per perk, end date and threshold, so each reminder is delivered once. */
  readonly id: string;
  readonly card: UsageExtraCard;
  readonly threshold: (typeof EXTRA_REMINDER_THRESHOLDS)[number]["id"];
}

/**
 * Reminders due now. Only the tightest threshold reached is due: opening the app 20 hours
 * before the end sends the one-day reminder, not a stale three-day one as well.
 */
export function dueExtraReminders(
  cards: readonly UsageExtraCard[],
  now: number,
  delivered: ReadonlySet<string>,
): UsageExtraReminder[] {
  return cards.flatMap((card) => {
    if (card.expiresAt === null || card.expiresAt <= now) return [];
    const left = card.expiresAt - now;
    const threshold = EXTRA_REMINDER_THRESHOLDS.find((candidate) => left <= candidate.ms);
    if (!threshold) return [];
    const id = `${card.key}@${card.expiresAt}:${threshold.id}`;
    return delivered.has(id) ? [] : [{ id, card, threshold: threshold.id }];
  });
}
