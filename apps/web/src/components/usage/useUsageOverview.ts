import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import {
  collectAutomaticExtras,
  collectUsageOverview,
  manualExtraCards,
  sortExtras,
} from "@t3tools/shared/usageOverview";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import { create } from "zustand";

import { useNowMinute } from "../../hooks/useNowMinute";
import { environmentPresentations } from "../../state/presentation";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { providerClients } from "../settings/providerDriverMeta";

/** Minute clock shared with the rest of the app; countdowns and resets advance with it. */
export function useUsageNow(): number {
  return Date.parse(`${useNowMinute()}:00.000Z`);
}

export function useUsageOverview(now: number) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  return collectUsageOverview(presentations, now);
}

export function providerLabel(driver: string): string {
  return providerClients.get(driver as never)?.label ?? driver;
}

/** A name safe to show as plain text: emails stay behind the redacting chips. */
export function accountPlainName(account: LimitAccount): string {
  return account.displayName ?? account.sourceLabel ?? providerLabel(String(account.driver));
}

/**
 * Manual extras are account facts, not per-server ones, so they live on the primary environment
 * (the server this client runs with). The hosted app has none and uses the thread's server.
 */
export function useExtrasHome(threadEnvironmentId: EnvironmentId | null): EnvironmentId | null {
  return usePrimaryEnvironmentId() ?? threadEnvironmentId;
}

export function useUsageExtras(home: EnvironmentId | null, now: number) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const homePresentation = home ? presentations.get(home) : undefined;
  const homeConfig = homePresentation?.serverConfig ?? null;
  const automatic = collectAutomaticExtras(collectLimitAccounts(presentations), (account) => ({
    service: providerLabel(String(account.driver)),
    name: accountPlainName(account),
  }));
  const manual = manualExtraCards(homeConfig?.settings.usageExtras ?? {});
  return {
    cards: sortExtras([...automatic, ...manual], now),
    homeLabel: homePresentation?.entry.target.label ?? null,
    /** Why extras cannot be saved, or null when they can. */
    saveBlocked:
      home === null || homeConfig === null
        ? "Connect to a server to save extras."
        : homeConfig.environment.capabilities.usageExtras !== true
          ? `Update ${homePresentation?.entry.target.label ?? "the server"} to save extras.`
          : null,
  };
}

/** Refreshes limits on every connected server, sharing the client-wide throttle with /usage. */
export function useRefreshUsage() {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  return (automatic: boolean) =>
    Promise.all(
      Array.from(presentations, ([environmentId, presentation]) =>
        presentation.connection.phase === "connected" && presentation.serverConfig !== null
          ? refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              automatic,
            ).catch(() => undefined)
          : undefined,
      ),
    ).then(() => undefined);
}

/**
 * Asks a mounted usage overview to bring its Extras into view, such as after the composer's
 * Extras button opened the drawer. Keyed by thread so another thread's drawer ignores it.
 */
export const useUsageExtrasFocusStore = create<{
  readonly request: { readonly threadKey: string; readonly id: number } | null;
  readonly lastId: number;
  readonly focusExtras: (threadKey: string) => void;
  /** Consumed once handled, so reopening the overview later does not jump again. */
  readonly handled: (id: number) => void;
}>()((set) => ({
  request: null,
  lastId: 0,
  focusExtras: (threadKey) =>
    set((state) => ({ request: { threadKey, id: state.lastId + 1 }, lastId: state.lastId + 1 })),
  handled: (id) => set((state) => (state.request?.id === id ? { request: null } : state)),
}));
