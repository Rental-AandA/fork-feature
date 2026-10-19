import {
  PROVIDER_DISPLAY_NAMES,
  UsageRotationStrategy,
  type ServerProvider,
  type UsageRotationDriverSettings,
  type UsageRotationSettings as UsageRotationSettingsValue,
} from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  rotationFamilies,
  withAccountIncluded,
  withAccountMoved,
} from "./UsageRotationSettings.logic";

const STRATEGY_LABELS: Record<UsageRotationDriverSettings["strategy"], string> = {
  order: "List order",
  "earliest-reset": "Earliest weekly reset",
  "most-remaining": "Most usage left",
};

const accountName = (provider: ServerProvider) => provider.displayName ?? provider.instanceId;

export function UsageRotationSettings({
  providers,
  rotation,
  readOnly,
  onChange,
}: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly rotation: UsageRotationSettingsValue;
  readonly readOnly: boolean;
  readonly onChange: (patch: UsageRotationSettingsValue) => void;
}) {
  const families = rotationFamilies(providers, rotation);
  if (families.length === 0) return null;
  return (
    <SettingsSection {...searchableSetting("usage-rotation")}>
      {families.map((family) => {
        const update = (next: UsageRotationDriverSettings) => onChange({ [family.driver]: next });
        const familyName = PROVIDER_DISPLAY_NAMES[family.driver] ?? family.driver;
        const included = family.accounts.filter((account) => account.included);
        return (
          <SettingsRow
            key={family.driver}
            title={`${familyName} accounts`}
            description={
              family.settings.enabled && included.length === 0
                ? "Tick the accounts a limited thread may continue on."
                : "When a thread hits a usage limit, it continues on the next ticked account with the same conversation. Reset credits are never used."
            }
            control={
              <Switch
                aria-label={`Rotate ${familyName} accounts`}
                checked={family.settings.enabled}
                disabled={readOnly}
                onCheckedChange={(enabled) => update({ ...family.settings, enabled })}
              />
            }
          >
            {family.settings.enabled ? (
              <div className="mt-3 space-y-2">
                <Select
                  value={family.settings.strategy}
                  disabled={readOnly}
                  onValueChange={(value) => {
                    const strategy = UsageRotationStrategy.literals.find(
                      (candidate) => candidate === value,
                    );
                    if (strategy !== undefined) update({ ...family.settings, strategy });
                  }}
                >
                  <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Next account">
                    <SelectValue>{STRATEGY_LABELS[family.settings.strategy]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {UsageRotationStrategy.literals.map((strategy) => (
                      <SelectItem hideIndicator key={strategy} value={strategy}>
                        {STRATEGY_LABELS[strategy]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <ul className="divide-y divide-border/50 rounded-md border border-border/60">
                  {family.accounts.map(({ provider, included: isIncluded }) => {
                    const position = family.settings.order.indexOf(provider.instanceId);
                    return (
                      <li key={provider.instanceId} className="flex items-center gap-2 px-3 py-2">
                        <Checkbox
                          aria-label={`Use ${accountName(provider)} in rotation`}
                          checked={isIncluded}
                          disabled={readOnly}
                          onCheckedChange={(checked) =>
                            update(
                              withAccountIncluded(
                                family.settings,
                                provider.instanceId,
                                checked === true,
                              ),
                            )
                          }
                        />
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {accountName(provider)}
                        </span>
                        {isIncluded ? (
                          <>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label={`Move ${accountName(provider)} up`}
                              disabled={readOnly || position <= 0}
                              onClick={() =>
                                update(withAccountMoved(family.settings, provider.instanceId, -1))
                              }
                            >
                              <ArrowUpIcon aria-hidden />
                            </Button>
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label={`Move ${accountName(provider)} down`}
                              disabled={readOnly || position >= included.length - 1}
                              onClick={() =>
                                update(withAccountMoved(family.settings, provider.instanceId, 1))
                              }
                            >
                              <ArrowDownIcon aria-hidden />
                            </Button>
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}
