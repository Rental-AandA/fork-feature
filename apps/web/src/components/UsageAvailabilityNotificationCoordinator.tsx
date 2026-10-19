import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { hasDesktopNotifications } from "../threadNotifications";
import { newUsageAvailabilityNotices } from "./UsageAvailabilityNotificationCoordinator.logic";
import { toastManager } from "./ui/toast";

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
  const mode = useClientSettings((settings) => settings.notificationMode);
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
      const focused = document.visibilityState === "visible" && document.hasFocus();
      if (inAppNotificationsEnabled && focused) {
        const toastId = toastManager.add({
          type: "success",
          title: notice.title,
          description: notice.body,
          data: {
            hideCopyButton: true,
            leadingIcon: <GaugeIcon aria-hidden className="size-4 text-success-foreground" />,
          },
          actionProps: {
            children: "Open providers",
            onClick: () => {
              toastManager.close(toastId);
              void navigate({ to: "/settings/providers" });
            },
          },
        });
        continue;
      }
      if (
        focused ||
        !hasDesktopNotifications(mode) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      )
        continue;
      try {
        const notification = new Notification(notice.title, {
          body: notice.body,
          tag: `usage-availability:${environmentId}:${notice.id}`,
          silent: true,
        });
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
  }, [environmentId, inAppNotificationsEnabled, mode, navigate, providers]);

  return null;
}
