import type { ServerProvider, ServerProviderUsageAvailability } from "@t3tools/contracts";

export interface UsageAvailabilityNotice {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

const formatReset = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });

export function describeUsageAvailability(
  provider: Pick<ServerProvider, "displayName" | "instanceId">,
  alert: ServerProviderUsageAvailability,
): UsageAvailabilityNotice {
  const name = provider.displayName ?? provider.instanceId;
  const window = alert.windowLabel === undefined ? "Its" : `The ${alert.windowLabel.toLowerCase()}`;
  switch (alert.kind) {
    case "available":
      return {
        id: alert.id,
        title: `${name} is available again`,
        body: "Its usage limit has reset.",
      };
    case "early-reset":
      return {
        id: alert.id,
        title: `${name} reset early`,
        body: `${window} limit reset ahead of schedule.`,
      };
    case "reset-moved-earlier":
      return {
        id: alert.id,
        title: `${name} resets sooner`,
        body:
          alert.resetsAt === undefined
            ? `${window} limit now resets earlier.`
            : `${window} limit now resets ${formatReset(alert.resetsAt)}.`,
      };
    case "credit-added":
      return {
        id: alert.id,
        title: `${name} has a new reset credit`,
        body: "Nothing was redeemed. Use it from Limits when you need it.",
      };
  }
}

/**
 * Alerts present on the first snapshot after connecting were already raised
 * while this client was away or before a reload, so they only seed `seen`.
 */
export function newUsageAvailabilityNotices(
  providers: ReadonlyArray<ServerProvider>,
  seen: Set<string> | null,
): { readonly seen: Set<string>; readonly notices: ReadonlyArray<UsageAvailabilityNotice> } {
  const next = new Set(seen ?? []);
  const notices: Array<UsageAvailabilityNotice> = [];
  for (const provider of providers) {
    const alert = provider.usageAvailability;
    if (alert === undefined || next.has(alert.id)) continue;
    next.add(alert.id);
    if (seen !== null) notices.push(describeUsageAvailability(provider, alert));
  }
  return { seen: next, notices };
}

export type UsageNoticeChannel = "toast" | "desktop" | null;

/**
 * Where a usage notice goes, as for thread notifications: a toast while the user looks at the
 * app and has in-app notifications on, a desktop notification while they are away and the
 * notification mode allows it, else nowhere yet.
 */
export function usageNoticeChannel(input: {
  readonly focused: boolean;
  readonly inAppNotificationsEnabled: boolean;
  /** The notification mode includes desktop notifications and the browser grants them. */
  readonly desktopAllowed: boolean;
}): UsageNoticeChannel {
  if (input.focused) return input.inAppNotificationsEnabled ? "toast" : null;
  return input.desktopAllowed ? "desktop" : null;
}
