import {
  ELEVENLABS_DEFAULT_BASE_URL,
  type EnvironmentId,
  type UsageLimitSourceConfig,
  UsageLimitSourceId,
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
import { Label } from "../ui/label";

const SOURCE_KINDS = {
  cliproxy: "CLIProxyAPI hub",
  elevenlabs: "ElevenLabs",
  canva: "Canva",
} as const satisfies Record<UsageLimitSourceKind, string>;

const isSourceKind = (value: unknown): value is UsageLimitSourceKind =>
  typeof value === "string" && value in SOURCE_KINDS;

/**
 * Dots and dashes are kept so `foo-bar.com` and `foo.bar.com` do not collide;
 * anything else (a port's colon, a path) is folded to a dash.
 */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sourceIdFromUrl(url: string): UsageLimitSourceId {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {}
  return UsageLimitSourceId.make(`cliproxy-${slug(host) || "hub"}`);
}

/** A label tells two accounts of the same service apart; without one, re-adding replaces. */
function sourceIdFromLabel(kind: UsageLimitSourceKind, label: string): UsageLimitSourceId {
  const suffix = slug(label);
  return UsageLimitSourceId.make(suffix ? `${kind}-${suffix}` : kind);
}

/**
 * Keys are sent once and kept in that server's secret store; settings only ever carry a
 * redaction marker for them afterwards.
 */
export function AddUsageLimitSourceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [kind, setKind] = useState<UsageLimitSourceKind>("cliproxy");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const trimmedLabel = label.trim();
  const trimmedUrl = url.trim();
  const trimmedKey = key.trim();
  const canSave =
    kind === "canva" ||
    (kind === "elevenlabs" && trimmedKey.length > 0) ||
    (kind === "cliproxy" && trimmedUrl.length > 0 && trimmedKey.length > 0);

  const reset = () => {
    setKind("cliproxy");
    setLabel("");
    setUrl("");
    setKey("");
  };

  const save = () => {
    if (!canSave) return;
    const labelField = trimmedLabel ? { label: trimmedLabel } : {};
    const [id, config]: readonly [UsageLimitSourceId, UsageLimitSourceConfig] =
      kind === "cliproxy"
        ? [
            sourceIdFromUrl(trimmedUrl),
            { kind, ...labelField, url: trimmedUrl, managementKey: trimmedKey, enabled: true },
          ]
        : kind === "elevenlabs"
          ? [
              sourceIdFromLabel(kind, trimmedLabel),
              {
                kind,
                ...labelField,
                apiKey: trimmedKey,
                baseUrl: trimmedUrl || ELEVENLABS_DEFAULT_BASE_URL,
                enabled: true,
              },
            ]
          : [sourceIdFromLabel(kind, trimmedLabel), { kind, ...labelField, enabled: true }];
    updateSettings({ usageLimitSources: { [id]: config } });
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
                  if (isSourceKind(value)) setKind(value);
                }}
              >
                <SelectTrigger id="usage-source-kind" aria-label="Usage source">
                  <SelectValue>{(value: UsageLimitSourceKind) => SOURCE_KINDS[value]}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {Object.entries(SOURCE_KINDS).map(([value, name]) => (
                    <SelectItem key={value} value={value}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {kind === "canva" ? (
              <p className="text-xs text-muted-foreground">
                Canva has no API for AI credits. The usage page links to Canva billing instead.
              </p>
            ) : (
              <>
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
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="usage-source-key">
                    {kind === "cliproxy" ? "Management key" : "API key"}
                  </Label>
                  <SecretInput
                    id="usage-source-key"
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                  />
                </div>
              </>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-label">Label (optional)</Label>
              <Input
                id="usage-source-label"
                placeholder={
                  kind === "cliproxy" ? "Defaults to the hub's host name" : SOURCE_KINDS[kind]
                }
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            Add source
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
