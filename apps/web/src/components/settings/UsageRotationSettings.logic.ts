import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  UsageRotationDriverSettings,
  UsageRotationSettings,
} from "@t3tools/contracts";

export const DEFAULT_ROTATION: UsageRotationDriverSettings = {
  enabled: false,
  strategy: "order",
  order: [],
};

export interface RotationFamily {
  readonly driver: ProviderDriverKind;
  readonly settings: UsageRotationDriverSettings;
  /** Listed accounts in rotation order, then the accounts left out. */
  readonly accounts: ReadonlyArray<{
    readonly provider: ServerProvider;
    readonly included: boolean;
  }>;
}

/** Rotation only makes sense for a driver with at least two accounts on this environment. */
export function rotationFamilies(
  providers: ReadonlyArray<ServerProvider>,
  rotation: UsageRotationSettings,
): ReadonlyArray<RotationFamily> {
  const byDriver = new Map<ProviderDriverKind, Array<ServerProvider>>();
  for (const provider of providers) {
    byDriver.set(provider.driver, [...(byDriver.get(provider.driver) ?? []), provider]);
  }
  return [...byDriver].flatMap(([driver, members]) => {
    if (members.length < 2) return [];
    const settings = rotation[driver] ?? DEFAULT_ROTATION;
    const rank = (provider: ServerProvider) => {
      const index = settings.order.indexOf(provider.instanceId);
      return index === -1 ? Number.POSITIVE_INFINITY : index;
    };
    const accounts = members
      .toSorted((left, right) => rank(left) - rank(right))
      .map((provider) => ({ provider, included: settings.order.includes(provider.instanceId) }));
    return [{ driver, settings, accounts }];
  });
}

export function withAccountIncluded(
  settings: UsageRotationDriverSettings,
  instanceId: ProviderInstanceId,
  included: boolean,
): UsageRotationDriverSettings {
  const order = settings.order.filter((candidate) => candidate !== instanceId);
  return { ...settings, order: included ? [...order, instanceId] : order };
}

export function withAccountMoved(
  settings: UsageRotationDriverSettings,
  instanceId: ProviderInstanceId,
  offset: -1 | 1,
): UsageRotationDriverSettings {
  const index = settings.order.indexOf(instanceId);
  const target = index + offset;
  if (index === -1 || target < 0 || target >= settings.order.length) return settings;
  const order = [...settings.order];
  order[index] = order[target]!;
  order[target] = instanceId;
  return { ...settings, order };
}
