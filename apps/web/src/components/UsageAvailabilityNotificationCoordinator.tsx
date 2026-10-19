import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { GaugeIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { hasDesktopNotifications, shortNotificationTag } from "../threadNotifications";
import {
  newUsageAvailabilityNotices,
  usageNoticeChannel,
} from "./UsageAvailabilityNotificationCoordinator.logic";
import { toastManager } from "./ui/toast";

export interface UsageNotice {
  /** Stable per notice; desktop notifications with the same key replace each other. */
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly toast: {
    readonly type: "success" | "warning";
    readonly leadingIcon: ReactNode;
    /** Milliseconds; 0 keeps the toast until it is dismissed. */
    readonly timeout?: number;
    readonly action?: { readonly label: string; readonly onClick: () => void };
  };
}

type UsageNoticeSettings = Pick<ClientSettings, "notificationMode" | "inAppNotificationsEnabled">;

/**
 * Shows a usage notice the way the app notifies about threads, honouring the notification
 * settings. Returns false when nothing could be shown right now, such as while the window is in
 * the background and desktop notifications are off.
 */
export function presentUsageNotice(notice: UsageNotice, settings: UsageNoticeSettings): boolean {
  const focused = document.visibilityState === "visible" && document.hasFocus();
  const channel = usageNoticeChannel({
    focused,
    inAppNotificationsEnabled: settings.inAppNotificationsEnabled,
    desktopAllowed:
      hasDesktopNotifications(settings.notificationMode) &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted",
  });
  if (channel === "toast") {
    const { action } = notice.toast;
    const toastId = toastManager.add({
      type: notice.toast.type,
      title: notice.title,
      description: notice.body,
      ...(notice.toast.timeout === undefined ? {} : { timeout: notice.toast.timeout }),
      data: { hideCopyButton: true, leadingIcon: notice.toast.leadingIcon },
      ...(action
        ? {
            actionProps: {
              children: action.label,
              onClick: () => {
                toastManager.close(toastId);
                action.onClick();
              },
            },
          }
        : {}),
    });
    return true;
  }
  if (channel !== "desktop") return false;
  try {
    const notification = new Notification(notice.title, {
      body: notice.body,
      tag: shortNotificationTag(notice.key),
      silent: true,
    });
    notification.addEventListener("click", () => {
      notification.close();
      window.focus();
    });
    return true;
  } catch {
    // Some browsers expose Notification but reject desktop presentation.
    return false;
  }
}

/** Tells the user when a limited account can take work again. One notice per limit episode. */
export function UsageAvailabilityNotificationCoordinator() {
  const environmentIds = useEnvironmentIds();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  if (mode === "off" && !inAppNotificationsEnabled) return null;
  return environmentIds.map((environmentId) => (
    <EnvironmentUsageAvailability key={environmentId} environmentId={environmentId} />
  ));
}

function EnvironmentUsageAvailability({ environmentId }: { environmentId: EnvironmentId }) {
  const providers = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.providers;
  const notificationMode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (providers === undefined) return;
    const { seen: nextSeen, notices } = newUsageAvailabilityNotices(providers, seen.current);
    seen.current = nextSeen;
    for (const notice of notices) {
      // An availability change is news only now, so one missed while away is not replayed.
      presentUsageNotice(
        {
          key: `usage-availability:${environmentId}:${notice.id}`,
          title: notice.title,
          body: notice.body,
          toast: {
            type: "success",
            leadingIcon: <GaugeIcon aria-hidden className="size-4 text-success-foreground" />,
            action: {
              label: "Open providers",
              onClick: () => void navigate({ to: "/settings/providers" }),
            },
          },
        },
        { notificationMode, inAppNotificationsEnabled },
      );
    }
  }, [environmentId, inAppNotificationsEnabled, notificationMode, navigate, providers]);

  return null;
}
