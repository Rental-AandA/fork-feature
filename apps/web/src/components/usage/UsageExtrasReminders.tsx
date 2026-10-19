import {
  dueExtraReminders,
  formatCountdown,
  type UsageExtraReminder,
} from "@t3tools/shared/usageOverview";
import { GiftIcon } from "lucide-react";
import { useEffect, useEffectEvent } from "react";

import { toastManager } from "../ui/toast";
import { useExtrasHome, useUsageExtras, useUsageNow } from "./useUsageOverview";

const DELIVERED_STORAGE_KEY = "t3code:usage-extra-reminders:v1";
/** Enough for years of reminders; the oldest ids drop off first. */
const MAX_DELIVERED_IDS = 300;

/**
 * Where a due reminder goes. The default is an in-app toast; the usage watcher's notification
 * path (desktop notifications, other devices) replaces it with `setUsageExtraReminderSink` once
 * it exists. Returning false leaves the reminder undelivered so it is offered again next minute.
 */
export type UsageExtraReminderSink = (reminder: UsageExtraReminder, now: number) => boolean;

const toastSink: UsageExtraReminderSink = (reminder, now) => {
  // A toast nobody sees is not a reminder, so wait until the window is in front.
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return false;
  const { card } = reminder;
  toastManager.add({
    type: "warning",
    title: `${card.service}: ${card.title} ends ${formatCountdown(card.expiresAt!, now)}`,
    description:
      card.remaining === null
        ? "Use it before it ends. Open Usage → Extras for details."
        : `${card.remaining.toLocaleString("en-US")} left. Use them before they end.`,
    timeout: 0,
    data: {
      hideCopyButton: true,
      leadingIcon: <GiftIcon aria-hidden className="size-4 text-warning-foreground" />,
    },
  });
  return true;
};

let reminderSink: UsageExtraReminderSink = toastSink;

/** Hook for the usage watcher's notification path; pass null to restore the in-app toast. */
export function setUsageExtraReminderSink(sink: UsageExtraReminderSink | null): void {
  reminderSink = sink ?? toastSink;
}

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

/**
 * Reminds three days and one day before an extra ends, once per extra and threshold on this
 * device. Checks each minute while the app is open.
 */
export function UsageExtrasReminderCoordinator() {
  const now = useUsageNow();
  const home = useExtrasHome(null);
  const { cards } = useUsageExtras(home, now);
  const dueKey = dueExtraReminders(cards, now, new Set())
    .map((reminder) => reminder.id)
    .join("|");

  const deliver = useEffectEvent(() => {
    const delivered = readDelivered();
    const sent = dueExtraReminders(cards, now, new Set(delivered))
      .filter((reminder) => reminderSink(reminder, now))
      .map((reminder) => reminder.id);
    if (sent.length > 0) writeDelivered([...delivered, ...sent]);
  });

  useEffect(() => {
    if (dueKey === "") return;
    deliver();
    // A reminder held back while the window was hidden goes out when it comes to the front.
    const onVisible = () => {
      if (document.visibilityState === "visible") deliver();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [dueKey]);

  return null;
}
