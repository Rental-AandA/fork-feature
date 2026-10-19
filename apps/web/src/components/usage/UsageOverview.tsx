import type { EnvironmentId } from "@t3tools/contracts";
import {
  formatCountdown,
  formatRunway,
  type FrontierFamily,
  type FrontierRow,
  type ToolLine,
  type ToolRow,
  type UsageForecast,
  type UsageOverview as UsageOverviewData,
  type UsageTone,
} from "@t3tools/shared/usageOverview";
import { AlertTriangleIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, type ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { formatContextWindowTokens, type ContextWindowSnapshot } from "../../lib/contextWindow";
import { ensureLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel, formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { UsageExtrasCarousel } from "./UsageExtras";
import { AccountAvatar, AccountName } from "./UsageLimitsPooled";
import {
  accountPlainName,
  providerLabel,
  useExtrasHome,
  useRefreshUsage,
  useUsageExtras,
  useUsageExtrasFocusStore,
  useUsageOverview,
} from "./useUsageOverview";

const TONE_BAR: Record<UsageTone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  out: "bg-destructive",
  unknown: "bg-foreground/45",
};

const TONE_LABEL: Record<UsageTone, string> = {
  ok: "On track",
  warn: "Running out before the reset",
  out: "Used up",
  unknown: "Too early in the window to judge the pace",
};

function useResetClock() {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  return (at: number, now: number) =>
    formatUpcomingTimestamp(new Date(at).toISOString(), timestampFormat, now);
}

function Bar({
  fraction,
  tone,
  thin = false,
  label,
}: {
  readonly fraction: number;
  readonly tone: UsageTone;
  readonly thin?: boolean;
  readonly label: string;
}) {
  const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={cn("w-full overflow-hidden rounded-full bg-muted", thin ? "h-0.5" : "h-1.5")}
    >
      <div
        className={cn("h-full rounded-full", thin ? "bg-foreground/35" : TONE_BAR[tone])}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function forecastText(forecast: UsageForecast | null, now: number): string | null {
  if (!forecast) return null;
  return forecast.kind === "lasts"
    ? "Lasts until the reset"
    : `Runs out ${formatCountdown(forecast.at, now)}, before the reset`;
}

function Freshness({ checkedAt, stale, now }: { checkedAt: number; stale: boolean; now: number }) {
  // Fresh numbers stay quiet; anything older than ten minutes says how old it is.
  if (now - checkedAt < 10 * 60_000) return null;
  return (
    <span className={cn("text-2xs", stale ? "text-warning-foreground" : "text-muted-foreground")}>
      {stale ? "Outdated · " : ""}updated{" "}
      {formatRelativeTimeLabel(new Date(checkedAt).toISOString(), now)}
    </span>
  );
}

function ResetText({
  resetsAt,
  estimated,
  now,
  clock,
  out = false,
}: {
  readonly resetsAt: number | null;
  readonly estimated: boolean;
  readonly now: number;
  readonly clock: (at: number, now: number) => string;
  readonly out?: boolean;
}) {
  if (resetsAt === null) {
    return <span className="text-muted-foreground">No reset reported</span>;
  }
  if (resetsAt <= now) {
    return <span className="text-muted-foreground">Reset due · refreshing</span>;
  }
  return (
    <span className={cn(out ? "font-medium text-foreground" : "text-muted-foreground")}>
      {out ? "Full again" : "Resets"} {formatCountdown(resetsAt, now)}
      <span className="text-muted-foreground"> · {clock(resetsAt, now)}</span>
      {estimated ? <span className="text-muted-foreground"> (estimated)</span> : null}
    </span>
  );
}

function FrontierAccountRow({
  row,
  recommended,
  now,
  clock,
}: {
  readonly row: FrontierRow;
  readonly recommended: FrontierFamily["recommendation"];
  readonly now: number;
  readonly clock: (at: number, now: number) => string;
}) {
  const { binding } = row;
  const out = row.tone === "out";
  const forecast = forecastText(row.forecast, now);
  const isRecommended = recommended?.accountKey === row.account.key;
  return (
    <li className={cn("flex flex-col gap-1 py-1.5", row.stale && "opacity-60")}>
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <AccountAvatar account={row.account} className="size-4" />
        <AccountName
          account={row.account}
          className="min-w-0 truncate font-medium text-foreground"
        />
        {isRecommended ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="shrink-0 rounded-full bg-success/15 px-1.5 py-px text-2xs font-medium text-success-foreground" />
              }
            >
              Use now
            </TooltipTrigger>
            <TooltipPopup side="top">
              {recommended.reason === "expiresSoon"
                ? `${recommended.remainingPercent}% left and it resets ${formatCountdown(recommended.resetsAt!, now)}. Whatever is unused then is lost.`
                : `Most headroom in this family: ${recommended.remainingPercent}% left.`}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <span className="ms-auto shrink-0 tabular-nums">
          <span className={cn("font-semibold", out ? "text-destructive" : "text-foreground")}>
            {binding.estimated ? "≈" : ""}
            {binding.remainingPercent}% left
          </span>
          <span className="text-muted-foreground"> · {binding.label}</span>
        </span>
      </div>
      <Tooltip>
        <TooltipTrigger render={<div className="flex flex-col gap-0.5" />}>
          <Bar
            fraction={binding.remainingPercent / 100}
            tone={row.tone}
            label={`${accountPlainName(row.account)}, ${binding.label}: ${binding.remainingPercent}% left`}
          />
          {row.others.map((other) => (
            <Bar
              key={other.id}
              thin
              fraction={other.remainingPercent / 100}
              tone={row.tone}
              label={`${other.label}: ${other.remainingPercent}% left`}
            />
          ))}
        </TooltipTrigger>
        <TooltipPopup side="top">
          <div className="flex flex-col gap-0.5">
            <span>{TONE_LABEL[row.tone]}</span>
            {[binding, ...row.others].map((window) => (
              <span key={window.id} className="text-muted-foreground tabular-nums">
                {window.label}: {window.remainingPercent}% left
                {window.resetsAt !== null && window.resetsAt > now
                  ? ` · resets ${formatCountdown(window.resetsAt, now)} (${clock(window.resetsAt, now)})`
                  : ""}
              </span>
            ))}
            {row.others.length > 0 ? (
              <span className="text-muted-foreground">
                The thick bar is the window that limits this account.
              </span>
            ) : null}
          </div>
        </TooltipPopup>
      </Tooltip>
      <div className="flex flex-wrap items-center justify-between gap-x-3 text-2xs tabular-nums">
        <ResetText
          resetsAt={binding.resetsAt}
          estimated={binding.estimated}
          now={now}
          clock={clock}
          out={out}
        />
        {forecast ? (
          <span
            className={
              row.forecast?.kind === "runsOut" ? "text-warning-foreground" : "text-muted-foreground"
            }
          >
            {forecast}
          </span>
        ) : null}
        <Freshness checkedAt={row.checkedAt} stale={row.stale} now={now} />
      </div>
    </li>
  );
}

function FrontierColumn({
  families,
  now,
  clock,
}: {
  readonly families: readonly FrontierFamily[];
  readonly now: number;
  readonly clock: (at: number, now: number) => string;
}) {
  return (
    <ColumnSection title="Frontier">
      {families.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No coding-agent account reports subscription limits yet.
        </p>
      ) : (
        families.map((family) => {
          const label = providerLabel(String(family.driver));
          return (
            <div key={family.driver} className="flex flex-col">
              <h4 className="flex items-center gap-1.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                <ProviderInstanceIcon
                  driverKind={family.driver}
                  displayName={label}
                  indicatorBackground="var(--background)"
                  className="size-3.5"
                  iconClassName="size-3 text-foreground/70"
                />
                {label}
              </h4>
              <ul className="flex flex-col divide-y divide-border/50">
                {family.rows.map((row) => (
                  <FrontierAccountRow
                    key={row.account.key}
                    row={row}
                    recommended={family.recommendation}
                    now={now}
                    clock={clock}
                  />
                ))}
              </ul>
            </div>
          );
        })
      )}
    </ColumnSection>
  );
}

function ToolLineView({
  line,
  tone,
  now,
  clock,
}: {
  readonly line: ToolLine;
  readonly tone: UsageTone;
  readonly now: number;
  readonly clock: (at: number, now: number) => string;
}) {
  const forecast = forecastText(line.forecast, now);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs tabular-nums">
        <span className="font-medium text-foreground">
          {line.estimated ? "≈ " : ""}
          {line.text}
        </span>
        {line.resetsAt !== null ? (
          <span className="text-2xs">
            <ResetText
              resetsAt={line.resetsAt}
              estimated={line.estimated}
              now={now}
              clock={clock}
            />
          </span>
        ) : null}
      </span>
      {line.fraction !== null ? (
        <Bar fraction={line.fraction} tone={tone} label={line.text} />
      ) : null}
      {line.spend || line.runwayDays !== null || forecast ? (
        <span className="flex flex-wrap gap-x-2 text-2xs text-muted-foreground tabular-nums">
          {line.spend ? <span>Spent {line.spend}</span> : null}
          {line.runwayDays !== null ? (
            <span className={cn(tone === "warn" && "text-warning-foreground")}>
              ≈ {formatRunway(line.runwayDays)}
            </span>
          ) : null}
          {forecast ? <span>{forecast}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

function ToolsColumn({
  rows,
  links,
  now,
  clock,
}: {
  readonly rows: readonly ToolRow[];
  readonly links: UsageOverviewData["links"];
  readonly now: number;
  readonly clock: (at: number, now: number) => string;
}) {
  return (
    <ColumnSection title="Tools & money">
      {rows.length === 0 && links.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No tool or money source yet. Add one in Settings → Providers → Usage sources.
        </p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border/50">
          {rows.map((row) => (
            <li
              key={row.account.key}
              className={cn("flex flex-col gap-1 py-1.5", row.stale && "opacity-60")}
            >
              <span className="flex min-w-0 items-baseline gap-2 text-xs">
                <AccountName
                  account={row.account}
                  className="truncate font-medium text-foreground"
                />
                {row.account.sourceLabel && row.account.sourceLabel !== row.account.displayName ? (
                  <span className="truncate text-2xs text-muted-foreground">
                    {row.account.sourceLabel}
                  </span>
                ) : null}
                {row.account.plan ? (
                  <span className="truncate text-2xs text-muted-foreground">
                    {row.account.plan.charAt(0).toUpperCase()}
                    {row.account.plan.slice(1)} plan
                  </span>
                ) : null}
                <span className="ms-auto">
                  <Freshness checkedAt={row.checkedAt} stale={row.stale} now={now} />
                </span>
              </span>
              {row.lines.map((line) => (
                <ToolLineView key={line.id} line={line} tone={row.tone} now={now} clock={clock} />
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      {links.map((link) => (
        <div key={link.url} className="flex items-center justify-between gap-2 py-1 text-xs">
          <span className="min-w-0">
            <span className="font-medium text-foreground">{link.label}</span>
            {link.message ? (
              <span className="block text-2xs text-muted-foreground">{link.message}</span>
            ) : null}
          </span>
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            Open
            <ExternalLinkIcon className="size-3" aria-hidden />
          </Button>
        </div>
      ))}
    </ColumnSection>
  );
}

function ColumnSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <h3 id={headingId} className="text-xs font-medium text-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The thread's context window as one bar; the composer meter shows the same numbers. */
export function ContextUsageBar({ usage }: { readonly usage: ContextWindowSnapshot | null }) {
  if (usage === null) {
    return (
      <p className="text-xs text-muted-foreground">
        Context: nothing reported for this thread yet.
      </p>
    );
  }
  const used = usage.usedPercentage;
  const tone: UsageTone = used === null ? "unknown" : used > 90 ? "out" : used > 75 ? "warn" : "ok";
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between gap-3 text-xs tabular-nums">
        <span className="font-medium text-foreground">Context</span>
        <span className="text-muted-foreground">
          {used !== null ? (
            <span className="font-semibold text-foreground">{Math.round(used)}% used</span>
          ) : null}
          {used !== null ? " · " : ""}
          {formatContextWindowTokens(usage.usedTokens)}
          {usage.maxTokens != null ? ` of ${formatContextWindowTokens(usage.maxTokens)}` : ""}{" "}
          tokens
          {usage.compactsAutomatically ? " · compacts automatically" : ""}
        </span>
      </span>
      {used !== null ? (
        <Bar fraction={used / 100} tone={tone} label={`Context window ${Math.round(used)}% used`} />
      ) : null}
    </div>
  );
}

function Notices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-warning/40 bg-warning/8 px-2.5 py-1.5 text-xs">
      {notices.map((notice) => (
        <span key={notice} className="flex items-start gap-1.5 text-foreground">
          <AlertTriangleIcon className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden />
          <span className="break-words">{notice}</span>
        </span>
      ))}
    </div>
  );
}

/** The earliest reset that passed after the numbers were read: they are outdated until refreshed. */
function passedReset(overview: UsageOverviewData, now: number): number | null {
  let passed: number | null = null;
  const consider = (resetsAt: number | null, checkedAt: number) => {
    if (resetsAt !== null && resetsAt <= now && resetsAt > checkedAt) {
      passed = Math.min(passed ?? resetsAt, resetsAt);
    }
  };
  for (const family of overview.frontier) {
    for (const row of family.rows) {
      for (const window of [row.binding, ...row.others]) consider(window.resetsAt, row.checkedAt);
    }
  }
  for (const row of overview.tools) {
    for (const line of row.lines) consider(line.resetsAt, row.checkedAt);
  }
  return passed;
}

/**
 * Quick usage overview: the thread's context, Frontier accounts beside Tools & money, and Extras.
 * Reads the same provider snapshots as /usage; it only asks for a refresh when shown and when a
 * reset passes.
 */
export function UsageOverview({
  now,
  threadKey,
  threadEnvironmentId,
  contextWindow,
}: {
  readonly now: number;
  readonly threadKey: string | null;
  readonly threadEnvironmentId: EnvironmentId | null;
  /** Undefined hides the context bar, for surfaces without a thread composer. */
  readonly contextWindow?: ContextWindowSnapshot | null;
}) {
  const overview = useUsageOverview(now);
  const clock = useResetClock();
  const home = useExtrasHome(threadEnvironmentId);
  const extras = useUsageExtras(home, now);
  const refresh = useRefreshUsage();
  const focusRequest = useUsageExtrasFocusStore((state) => state.request);
  const focusRequestId =
    focusRequest !== null && focusRequest.threadKey === threadKey ? focusRequest.id : 0;

  const refreshNow = useEffectEvent((automatic: boolean) => void refresh(automatic));
  useEffect(() => {
    // Throttled with /usage, so reopening the drawer does not hammer the servers.
    refreshNow(true);
  }, []);
  useEffect(() => {
    // The carousel's own effect ran first and brought itself into view.
    if (focusRequestId !== 0) useUsageExtrasFocusStore.getState().handled(focusRequestId);
  }, [focusRequestId]);
  const resetPassedAt = passedReset(overview, now);
  useEffect(() => {
    // Once per passed reset: numbers read before it are outdated.
    if (resetPassedAt !== null) refreshNow(false);
  }, [resetPassedAt]);

  return (
    <div className="@container/usage flex min-w-0 flex-col gap-3">
      {contextWindow !== undefined ? <ContextUsageBar usage={contextWindow} /> : null}
      <div className="grid min-w-0 gap-x-6 gap-y-3 @2xl/usage:grid-cols-2">
        <FrontierColumn families={overview.frontier} now={now} clock={clock} />
        <ToolsColumn rows={overview.tools} links={overview.links} now={now} clock={clock} />
      </div>
      <Notices notices={overview.notices} />
      <UsageExtrasCarousel
        cards={extras.cards}
        now={now}
        home={home}
        homeLabel={extras.homeLabel}
        saveBlocked={extras.saveBlocked}
        focusRequestId={focusRequestId}
      />
    </div>
  );
}
