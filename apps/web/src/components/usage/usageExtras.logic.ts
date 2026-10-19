import type { UsageExtra } from "@t3tools/contracts";

export interface UsageExtraDraft {
  readonly service: string;
  readonly title: string;
  readonly remaining: string;
  /** `YYYY-MM-DD` from a date input. */
  readonly endsOn: string;
}

export const EMPTY_USAGE_EXTRA_DRAFT: UsageExtraDraft = {
  service: "",
  title: "",
  remaining: "",
  endsOn: "",
};

/** Services with perks worth tracking; the field still takes any name. */
export const USAGE_EXTRA_SERVICE_SUGGESTIONS = [
  "Higgsfield",
  "ElevenLabs",
  "Canva",
  "fal",
  "OpenRouter",
  "DeepSeek",
  "Codex",
  "Claude",
  "Antigravity",
] as const;

/**
 * A perk "ends on" a day the user picks, so it lasts through the end of that day where they are.
 * Null while the draft is incomplete or names a day already over.
 */
export function usageExtraFromDraft(draft: UsageExtraDraft, now: number): UsageExtra | null {
  const service = draft.service.trim();
  const title = draft.title.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(draft.endsOn);
  if (!service || !title || !match) return null;
  const end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  if (Number.isNaN(end.getTime()) || end.getTime() <= now) return null;
  const remainingText = draft.remaining.trim();
  let remaining: number | undefined;
  if (remainingText !== "") {
    remaining = Number(remainingText);
    if (!Number.isInteger(remaining) || remaining < 0) return null;
  }
  return {
    service,
    title,
    ...(remaining === undefined ? {} : { remaining }),
    expiresAt: end.toISOString(),
  };
}

export function newUsageExtraId(now: number): string {
  return `extra-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
