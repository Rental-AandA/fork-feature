import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  newUsageAvailabilityNotices,
  usageNoticeChannel,
} from "./UsageAvailabilityNotificationCoordinator.logic";

const provider = (
  instanceId: string,
  alert?: ServerProvider["usageAvailability"],
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(`codex-${instanceId}`),
  driver: ProviderDriverKind.make("codex"),
  displayName: `Codex ${instanceId}`,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-20T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...(alert === undefined ? {} : { usageAvailability: alert }),
});

const available = {
  id: "2:available:weekly@2026-10-25",
  kind: "available" as const,
  detectedAt: "2026-10-20T12:00:00.000Z",
  windowLabel: "Weekly",
};

describe("usage availability notices", () => {
  it("stays quiet for alerts already present when the client connects", () => {
    const first = newUsageAvailabilityNotices([provider("2", available)], null);
    expect(first.notices).toEqual([]);
    // The same alert on every later provider update never repeats.
    expect(newUsageAvailabilityNotices([provider("2", available)], first.seen).notices).toEqual([]);
  });

  it("announces each new alert once", () => {
    const { seen } = newUsageAvailabilityNotices([provider("2")], null);
    const credit = {
      id: "3:credit-added:1:c1",
      kind: "credit-added" as const,
      detectedAt: "2026-10-20T12:05:00.000Z",
    };
    const next = newUsageAvailabilityNotices(
      [provider("2", available), provider("3", credit)],
      seen,
    );
    expect(next.notices.map((notice) => notice.title)).toEqual([
      "Codex 2 is available again",
      "Codex 3 has a new reset credit",
    ]);
    expect(next.notices[1]!.body).toContain("Nothing was redeemed");
    expect(newUsageAvailabilityNotices([provider("2", available)], next.seen).notices).toEqual([]);
  });
});

describe("usage notice channel", () => {
  it("toasts while the user looks at the app, if in-app notifications are on", () => {
    expect(
      usageNoticeChannel({ focused: true, inAppNotificationsEnabled: true, desktopAllowed: true }),
    ).toBe("toast");
    // No desktop notification for a window the user is looking at.
    expect(
      usageNoticeChannel({ focused: true, inAppNotificationsEnabled: false, desktopAllowed: true }),
    ).toBeNull();
  });

  it("uses a desktop notification while away only when the notification mode allows it", () => {
    expect(
      usageNoticeChannel({ focused: false, inAppNotificationsEnabled: true, desktopAllowed: true }),
    ).toBe("desktop");
    expect(
      usageNoticeChannel({
        focused: false,
        inAppNotificationsEnabled: true,
        desktopAllowed: false,
      }),
    ).toBeNull();
  });
});
