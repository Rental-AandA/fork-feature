import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProviderInstanceId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { useState } from "react";

import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { useQuietThreadShell } from "../../state/entities";
import { UsageOverview } from "./UsageOverview";
import { useRefreshUsage, useUsageNow } from "./useUsageOverview";

/** The usage view of the bottom drawer; mounted only while it is shown, so its clock stops. */
export function UsageDrawerBody({
  threadKey,
  threadEnvironmentId,
  threadInstanceId,
  contextWindow,
}: {
  readonly threadKey: string;
  readonly threadEnvironmentId: EnvironmentId;
  readonly threadInstanceId: ProviderInstanceId | null;
  readonly contextWindow: ContextWindowSnapshot | null;
}) {
  const now = useUsageNow();
  return (
    <UsageOverview
      now={now}
      threadKey={threadKey}
      threadEnvironmentId={threadEnvironmentId}
      threadInstanceId={threadInstanceId}
      contextWindow={contextWindow}
    />
  );
}

export function UsageDrawerActions() {
  const navigate = useNavigate();
  const refresh = useRefreshUsage();
  const [refreshing, setRefreshing] = useState(false);
  return (
    <>
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={refreshing}
        aria-label="Refresh usage"
        title="Refresh usage"
        onClick={() => {
          setRefreshing(true);
          void refresh(false).finally(() => setRefreshing(false));
        }}
      >
        <RefreshIcon size="sm" refreshing={refreshing} />
      </Button>
      <Button size="xs" variant="ghost-muted" onClick={() => void navigate({ to: "/usage" })}>
        Full usage
        <ArrowUpRightIcon className="size-3" aria-hidden />
      </Button>
    </>
  );
}

/**
 * The same overview as a right-panel tab, for a wider look beside the chat. The thread's context
 * stays with the composer meter and the drawer, which already sit next to the chat.
 */
export function UsagePanelSurface({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const now = useUsageNow();
  const threadInstanceId = useQuietThreadShell(threadRef)?.providerInstanceId ?? null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-end gap-1 border-b border-border/70 px-2">
        <UsageDrawerActions />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2.5">
        <UsageOverview
          now={now}
          threadKey={scopedThreadKey(threadRef)}
          threadEnvironmentId={threadRef.environmentId}
          threadInstanceId={threadInstanceId}
        />
      </div>
    </div>
  );
}
