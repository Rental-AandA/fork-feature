import { UsageLimitSourceId, type EnvironmentId, type UnifiedSettings } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { USAGE_SOURCE_KIND_NAMES } from "./AddUsageLimitSourceDialog.logic";
import { searchableSetting } from "./settingsSearch";
import { useUsageSourceConnect } from "./useUsageSourceConnect";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  cursorKeychainUsageEnabled,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly cursorKeychainUsageEnabled: boolean;
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const updateCursorSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update Cursor account usage",
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const platform = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment
    .platform;
  const [adding, setAdding] = useState(false);
  const [updatingCursor, setUpdatingCursor] = useState(false);
  const entries = Object.entries(sources);

  const setCursorUsageEnabled = async (enabled: boolean) => {
    setUpdatingCursor(true);
    const result = await updateCursorSettings({
      environmentId,
      input: { patch: { cursorKeychainUsageEnabled: enabled } },
    });
    if (result._tag === "Success") {
      await refreshProviders({ environmentId, input: {} });
    }
    setUpdatingCursor(false);
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              Add source
            </Button>
          ) : null
        }
      >
        {platform?.os === "darwin" ? (
          <SettingsRow
            id="cursor-keychain-usage"
            title="Cursor account usage"
            description="Read your existing Cursor CLI login from macOS Keychain to show account history and monthly limits. macOS may ask you to allow access."
            control={
              <Switch
                aria-label="Cursor account usage"
                checked={cursorKeychainUsageEnabled}
                disabled={readOnly || updatingCursor}
                onCheckedChange={(enabled) => void setCursorUsageEnabled(enabled)}
              />
            }
          />
        ) : null}
        {entries.length === 0 ? (
          <SettingsRow title="No usage sources configured." />
        ) : (
          entries.map(([id, source]) => {
            const location =
              source.kind === "cliproxy"
                ? source.url
                : source.kind === "elevenlabs"
                  ? source.baseUrl
                  : null;
            const label = source.label?.trim() || location || USAGE_SOURCE_KIND_NAMES[source.kind];
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    {USAGE_SOURCE_KIND_NAMES[source.kind]}
                    {source.enabled ? "" : " · Disabled"}
                    {source.kind === "higgsfield" && !source.refreshToken ? " · Not connected" : ""}
                    {location && label !== location ? ` · ${location}` : ""}
                  </span>
                }
                control={
                  !readOnly ? (
                    <span className="flex items-center gap-1">
                      {source.kind === "higgsfield" ? (
                        <ConnectUsageSourceButton
                          environmentId={environmentId}
                          sourceId={UsageLimitSourceId.make(id)}
                          connected={Boolean(source.refreshToken)}
                        />
                      ) : null}
                      <RemoveUsageProviderButton
                        label={label}
                        onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                      />
                    </span>
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <AddUsageLimitSourceDialog
          open
          onOpenChange={setAdding}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          existingIds={new Set(Object.keys(sources))}
        />
      ) : null}
    </>
  );
}

/** Reconnecting replaces an expired or revoked sign-in; the current one keeps working until then. */
function ConnectUsageSourceButton({
  environmentId,
  sourceId,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly sourceId: UsageLimitSourceId;
  readonly connected: boolean;
}) {
  const signIn = useUsageSourceConnect(environmentId);
  if (signIn.state.status === "waiting") {
    return (
      <Button size="xs" variant="ghost" onClick={signIn.reopen}>
        Open sign-in again
      </Button>
    );
  }
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={signIn.state.status === "starting"}
      title={signIn.state.status === "failed" ? signIn.state.message : undefined}
      onClick={() => void signIn.start({ sourceId })}
    >
      {signIn.state.status === "failed" ? "Retry sign-in" : connected ? "Reconnect" : "Connect"}
    </Button>
  );
}

function RemoveUsageProviderButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              The hub's management key is deleted from this server. Its accounts leave the Limits
              view; the hub itself is untouched. Add it again with the URL and key to bring them
              back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Remove hub
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
