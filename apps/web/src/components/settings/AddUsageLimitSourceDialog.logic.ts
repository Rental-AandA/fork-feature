import {
  ELEVENLABS_DEFAULT_BASE_URL,
  type UsageLimitSourceConfig,
  UsageLimitSourceId,
  type UsageLimitSourceKind,
} from "@t3tools/contracts";

export const USAGE_SOURCE_KIND_NAMES = {
  cliproxy: "CLIProxyAPI hub",
  elevenlabs: "ElevenLabs",
  canva: "Canva",
  fal: "fal",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  typesafe: "TypeSafe (Jev)",
} as const satisfies Record<UsageLimitSourceKind, string>;

export const isUsageSourceKind = (value: unknown): value is UsageLimitSourceKind =>
  typeof value === "string" && value in USAGE_SOURCE_KIND_NAMES;

export interface UsageSourceDraft {
  readonly kind: UsageLimitSourceKind;
  readonly label: string;
  readonly url: string;
  readonly key: string;
  readonly managementKey: string;
  readonly startCredit: string;
  readonly startDate: string;
}

export const EMPTY_USAGE_SOURCE_DRAFT: UsageSourceDraft = {
  kind: "cliproxy",
  label: "",
  url: "",
  key: "",
  managementKey: "",
  startCredit: "",
  startDate: "",
};

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

/**
 * A hub is identified by its URL, so adding the same hub again updates it.
 * Every other source gets a fresh id, so a second account of the same service
 * never replaces the first, with or without a label.
 */
export function usageSourceId(
  draft: Pick<UsageSourceDraft, "kind" | "label" | "url">,
  existingIds: ReadonlySet<string>,
): UsageLimitSourceId {
  if (draft.kind === "cliproxy") {
    let host = draft.url.trim();
    try {
      host = new URL(host).host;
    } catch {}
    return UsageLimitSourceId.make(`cliproxy-${slug(host) || "hub"}`);
  }
  const suffix = slug(draft.label);
  const base = suffix ? `${draft.kind}-${suffix}` : draft.kind;
  let id = base;
  for (let next = 2; existingIds.has(id); next += 1) id = `${base}-${next}`;
  return UsageLimitSourceId.make(id);
}

function parseStartCredit(value: string): number | undefined | null {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const amount = Number(trimmed);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/** Null while the draft is missing something its kind needs. */
export function usageSourceConfig(draft: UsageSourceDraft): UsageLimitSourceConfig | null {
  const label = draft.label.trim();
  const url = draft.url.trim();
  const key = draft.key.trim();
  const base = { ...(label ? { label } : {}), enabled: true };
  switch (draft.kind) {
    case "cliproxy":
      return url && key ? { kind: draft.kind, ...base, url, managementKey: key } : null;
    case "elevenlabs":
      return key
        ? { kind: draft.kind, ...base, apiKey: key, baseUrl: url || ELEVENLABS_DEFAULT_BASE_URL }
        : null;
    case "fal":
    case "deepseek":
      return key ? { kind: draft.kind, ...base, apiKey: key } : null;
    case "openrouter":
      return key
        ? { kind: draft.kind, ...base, apiKey: key, managementKey: draft.managementKey.trim() }
        : null;
    case "canva":
      return { kind: draft.kind, ...base };
    case "typesafe": {
      const startCredit = parseStartCredit(draft.startCredit);
      const startDate = draft.startDate.trim();
      if (startCredit === null) return null;
      return {
        kind: draft.kind,
        ...base,
        ...(startCredit === undefined ? {} : { startCredit }),
        ...(startDate ? { startDate } : {}),
      };
    }
  }
}
