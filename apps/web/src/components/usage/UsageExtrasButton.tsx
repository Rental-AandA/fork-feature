import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { isExtraEndingSoon } from "@t3tools/shared/usageOverview";
import { GiftIcon } from "lucide-react";

import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  useExtrasHome,
  useUsageExtras,
  useUsageExtrasFocusStore,
  useUsageNow,
} from "./useUsageOverview";

/**
 * Sits beside the context meter. The badge counts extras ending within three days; a click opens
 * the drawer's usage view at the Extras strip.
 */
export function UsageExtrasButton({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const now = useUsageNow();
  const home = useExtrasHome(threadRef.environmentId);
  const { cards } = useUsageExtras(home, now);
  const endingSoon = cards.filter((card) => isExtraEndingSoon(card, now)).length;
  const active = cards.filter((card) => card.expiresAt === null || card.expiresAt > now).length;
  const summary =
    endingSoon > 0
      ? `${endingSoon} ${endingSoon === 1 ? "extra ends" : "extras end"} within 3 days`
      : active > 0
        ? `${active} ${active === 1 ? "extra" : "extras"}, none ending soon`
        : "Plan perks and banked resets";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="relative size-7"
            aria-label={`Extras: ${summary}`}
            onClick={() => {
              useTerminalUiStateStore.getState().setDrawerView(threadRef, "usage", true);
              useUsageExtrasFocusStore.getState().focusExtras(scopedThreadKey(threadRef));
            }}
          />
        }
      >
        <GiftIcon aria-hidden />
        {endingSoon > 0 ? (
          <span
            aria-hidden
            className="absolute -end-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-background px-0.5 text-3xs font-semibold leading-none text-warning-foreground tabular-nums ring-1 ring-warning ring-inset"
          >
            {endingSoon}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">Extras · {summary}</TooltipPopup>
    </Tooltip>
  );
}
