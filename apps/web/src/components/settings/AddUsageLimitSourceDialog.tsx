import {
  ELEVENLABS_DEFAULT_BASE_URL,
  type EnvironmentId,
  type UsageLimitSourceId,
  type UsageLimitSourceKind,
} from "@t3tools/contracts";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretInput } from "./SecretInput";
import { useUsageSourceConnect } from "./useUsageSourceConnect";
import { Label } from "../ui/label";
import {
  EMPTY_USAGE_SOURCE_DRAFT,
  USAGE_SOURCE_KIND_NAMES,
  isUsageSourceKind,
  usageSourceConfig,
  usageSourceId,
  type UsageSourceDraft,
} from "./AddUsageLimitSourceDialog.logic";

const KIND_NOTES: Partial<Record<UsageLimitSourceKind, string>> = {
  canva: "Canva has no API for AI credits. The usage page links to Canva billing instead.",
  fal: "Reading the balance needs a key with the BILLING or FULL preset; a plain API key is refused.",
  deepseek: "DeepSeek reports no spend, so spend is counted from balance changes from now on.",
  openrouter:
    "The API key shows its own spend. Add a management key to also see the account balance.",
  typesafe:
    "TypeSafe has no balance API. Jev spend is counted once winnow is connected; until then the usage page links to the console.",
  higgsfield:
    "Sign in with your Higgsfield account in the browser. The sign-in returns to this server, so finish it on the computer running it. The monthly allowance and reset date are estimated from your credit history.",
};

/**
 * Keys are sent once and kept in that server's secret store; settings only ever carry a
 * redaction marker for them afterwards.
 */
export function AddUsageLimitSourceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  existingIds,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly existingIds: ReadonlySet<string>;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const signIn = useUsageSourceConnect(environmentId);
  const [draft, setDraft] = useState<UsageSourceDraft>(EMPTY_USAGE_SOURCE_DRAFT);
  // A sign-in creates its source on the server, so a retry must reuse that id, not add another.
  const [signInSourceId, setSignInSourceId] = useState<UsageLimitSourceId | null>(null);
  const { kind } = draft;
  const edit =
    (field: Exclude<keyof UsageSourceDraft, "kind">) =>
    (event: { readonly target: { readonly value: string } }) =>
      setDraft((current) => ({ ...current, [field]: event.target.value }));
  const config = usageSourceConfig(draft);
  const hasUrl = kind === "cliproxy" || kind === "elevenlabs";
  const hasKey = kind !== "canva" && kind !== "typesafe" && kind !== "higgsfield";
  const note = KIND_NOTES[kind];

  const reset = () => {
    setDraft(EMPTY_USAGE_SOURCE_DRAFT);
    setSignInSourceId(null);
    signIn.reset();
  };

  const save = () => {
    if (!config) return;
    if (config.kind === "higgsfield") {
      // The server creates the source with the sign-in; the dialog stays open to guide it.
      const sourceId = signInSourceId ?? usageSourceId(draft, existingIds);
      setSignInSourceId(sourceId);
      void signIn.start({
        sourceId,
        ...(config.label ? { label: config.label } : {}),
      });
      return;
    }
    updateSettings({ usageLimitSources: { [usageSourceId(draft, existingIds)]: config } });
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a usage source</DialogTitle>
          <DialogDescription>
            Show external quotas and credits next to the providers on {environmentLabel}. Keys stay
            on that server.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {signIn.state.status === "waiting" || signIn.state.status === "failed" ? (
            <div className="grid gap-2 text-sm">
              {signIn.state.status === "waiting" ? (
                <>
                  <p className="text-foreground">
                    Finish signing in to Higgsfield in your browser.
                  </p>
                  <p className="text-muted-foreground">
                    Credits appear on the Usage page once you are signed in. You can close this
                    dialog.
                  </p>
                </>
              ) : (
                <p className="text-destructive">{signIn.state.message}</p>
              )}
            </div>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="usage-source-kind">Source</Label>
                <Select
                  value={kind}
                  onValueChange={(value) => {
                    if (isUsageSourceKind(value)) {
                      setDraft((current) => ({ ...current, kind: value }));
                    }
                  }}
                >
                  <SelectTrigger id="usage-source-kind" aria-label="Usage source">
                    <SelectValue>
                      {(value: UsageLimitSourceKind) => USAGE_SOURCE_KIND_NAMES[value]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {Object.entries(USAGE_SOURCE_KIND_NAMES).map(([value, name]) => (
                      <SelectItem key={value} value={value}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
              {hasUrl ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-url">
                    {kind === "cliproxy" ? "Hub URL" : "API URL (optional)"}
                  </Label>
                  <Input
                    id="usage-source-url"
                    placeholder={
                      kind === "cliproxy"
                        ? "https://hub.example.ts.net:8318"
                        : ELEVENLABS_DEFAULT_BASE_URL
                    }
                    value={draft.url}
                    onChange={edit("url")}
                  />
                </div>
              ) : null}
              {hasKey ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-key">
                    {kind === "cliproxy" ? "Management key" : "API key"}
                  </Label>
                  <SecretInput id="usage-source-key" value={draft.key} onChange={edit("key")} />
                </div>
              ) : null}
              {kind === "openrouter" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-management-key">Management key (optional)</Label>
                  <SecretInput
                    id="usage-source-management-key"
                    value={draft.managementKey}
                    onChange={edit("managementKey")}
                  />
                </div>
              ) : null}
              {kind === "typesafe" ? (
                <>
                  <div className="grid gap-1.5">
                    <Label htmlFor="usage-source-start-credit">
                      Starting credit in USD (optional)
                    </Label>
                    <Input
                      id="usage-source-start-credit"
                      inputMode="decimal"
                      placeholder="50"
                      value={draft.startCredit}
                      onChange={edit("startCredit")}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="usage-source-start-date">Bought on (optional)</Label>
                    <Input
                      id="usage-source-start-date"
                      type="date"
                      value={draft.startDate}
                      onChange={edit("startDate")}
                    />
                  </div>
                </>
              ) : null}
              <div className="grid gap-1.5">
                <Label htmlFor="usage-source-label">Label (optional)</Label>
                <Input
                  id="usage-source-label"
                  placeholder={
                    kind === "cliproxy"
                      ? "Defaults to the hub's host name"
                      : USAGE_SOURCE_KIND_NAMES[kind]
                  }
                  value={draft.label}
                  onChange={edit("label")}
                />
              </div>
            </form>
          )}
        </DialogPanel>
        <DialogFooter variant="bare">
          {signIn.state.status === "waiting" ? null : (
            <Button
              variant="outline"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
          )}
          {signIn.state.status === "waiting" ? (
            <>
              <Button variant="outline" onClick={signIn.reopen}>
                Open sign-in again
              </Button>
              <Button
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                Done
              </Button>
            </>
          ) : signIn.state.status === "failed" ? (
            <Button onClick={signIn.reset}>Back</Button>
          ) : (
            <Button onClick={save} disabled={!config || signIn.state.status === "starting"}>
              {kind === "higgsfield" ? "Connect Higgsfield" : "Add source"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
