import {
  dueExtraReminders,
  formatCountdown,
  type UsageExtraReminder,
} from "@t3tools/shared/usageOverview";
import { GiftIcon } from "lucide-react";
import { useEffect, useEffectEvent } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { presentUsageNotice } from "../UsageAvailabilityNotificationCoordinator";
import { useExtrasHome, useUsageExtras, useUsageNow } from "./useUsageOverview";

const DELIVERED_STORAGE_KEY = "t3code:usage-extra-reminders:v1";
/** Enough for years of reminders; the oldest ids drop off first. */
const MAX_DELIVERED_IDS = 300;

function readDelivered(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(DELIVERED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeDelivered(ids: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(
      DELIVERED_STORAGE_KEY,
      JSON.stringify(ids.slice(-MAX_DELIVERED_IDS)),
    );
  } catch {
    // Storage can be full or blocked; the reminder may then repeat, which beats losing it.
  }
}

function reminderNotice(reminder: UsageExtraReminder, now: number) {
  const { card } = reminder;
  return {
    key: `usage-extra:${reminder.id}`,
    title: `${card.service}: ${card.title} ends ${formatCountdown(card.expiresAt!, now)}`,
    body:
      card.remaining === null
        ? "Use it before it ends. Open Usage → Extras for details."
        : `${card.remaining.toLocaleString("en-US")} left. Use them before they end.`,
    toast: {
      type: "warning" as const,
      leadingIcon: <GiftIcon aria-hidden className="size-4 text-warning-foreground" />,
      timeout: 0,
    },
  };
}

/**
 * Reminds three days and one day before an extra ends, once per extra and threshold on this
 * device, through the same toast or desktop notification as other usage notices. A reminder the
 * notification settings hold back now stays due and goes out once it can be shown, for example
 * when the window comes back to the front.
 */
export function UsageExtrasReminderCoordinator() {
  const now = useUsageNow();
  const home = useExtrasHome(null);
  const { cards } = useUsageExtras(home, now);
  const notificationMode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const dueKey = dueExtraReminders(cards, now, new Set())
    .map((reminder) => reminder.id)
    .join("|");

  const deliver = useEffectEvent(() => {
    const delivered = readDelivered();
    const sent = dueExtraReminders(cards, now, new Set(delivered))
      .filter((reminder) =>
        presentUsageNotice(reminderNotice(reminder, now), {
          notificationMode,
          inAppNotificationsEnabled,
        }),
      )
      .map((reminder) => reminder.id);
    if (sent.length > 0) writeDelivered([...delivered, ...sent]);
  });

  useEffect(() => {
    if (dueKey === "") return;
    deliver();
    // Focus decides between toast and desktop notification, so retry whenever it changes.
    document.addEventListener("visibilitychange", deliver);
    window.addEventListener("focus", deliver);
    window.addEventListener("blur", deliver);
    return () => {
      document.removeEventListener("visibilitychange", deliver);
      window.removeEventListener("focus", deliver);
      window.removeEventListener("blur", deliver);
    };
  }, [dueKey]);

  return null;
}
