import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  UsageRotationSettings,
} from "@t3tools/contracts";
import { pickRotationAccount } from "@t3tools/shared/usageRotation";

/** What the usage overview says about account rotation for one family. */
export type RotationHint =
  | { readonly kind: "off" }
  | { readonly kind: "noneTicked" }
  | { readonly kind: "next"; readonly accountName: string }
  | { readonly kind: "noneFree" };

/**
 * Hints for the families of the thread's server with two or more enabled accounts, where rotation
 * can matter. "Next" is the account a limited thread would move to now; the thread's own account
 * is left out, as the server leaves out the account that hit the limit.
 */
export function rotationHints(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly rotation: UsageRotationSettings;
  readonly threadInstanceId: ProviderInstanceId | null;
  readonly nowMs: number;
}): ReadonlyMap<ProviderDriverKind, RotationHint> {
  const enabled = input.providers.filter((provider) => provider.enabled);
  const counts = new Map<ProviderDriverKind, number>();
  for (const provider of enabled) {
    counts.set(provider.driver, (counts.get(provider.driver) ?? 0) + 1);
  }
  const threadDriver = enabled.find(
    (provider) => provider.instanceId === input.threadInstanceId,
  )?.driver;
  const hints = new Map<ProviderDriverKind, RotationHint>();
  for (const [driver, count] of counts) {
    if (count < 2) continue;
    const settings = input.rotation[driver];
    if (settings?.enabled !== true) {
      hints.set(driver, { kind: "off" });
      continue;
    }
    const ticked = enabled.some(
      (provider) => provider.driver === driver && settings.order.includes(provider.instanceId),
    );
    if (!ticked) {
      hints.set(driver, { kind: "noneTicked" });
      continue;
    }
    const next = pickRotationAccount({
      driver,
      rotation: settings,
      providers: input.providers,
      nowMs: input.nowMs,
      excludeInstanceId:
        threadDriver === driver ? (input.threadInstanceId ?? undefined) : undefined,
    });
    hints.set(
      driver,
      next === null
        ? { kind: "noneFree" }
        : { kind: "next", accountName: resolveProviderInstanceDisplayName(next) },
    );
  }
  return hints;
}
