import type { EnvironmentId } from "@t3tools/contracts";
import { AuthProvidersManageScope } from "@t3tools/contracts";
import {
  formatCountdown,
  isExtraEndingSoon,
  type UsageExtraCard,
} from "@t3tools/shared/usageOverview";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { ChevronLeftIcon, ChevronRightIcon, GiftIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { readEnvironmentScope } from "../../state/session";
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
import { Label } from "../ui/label";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ResetCreditDialog, useResetCredit } from "./UsageLimits";
import {
  EMPTY_USAGE_EXTRA_DRAFT,
  USAGE_EXTRA_SERVICE_SUGGESTIONS,
  newUsageExtraId,
  usageExtraFromDraft,
} from "./usageExtras.logic";

function formatEndDate(at: number, now: number): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(at);
}

function EndsLine({ card, now }: { readonly card: UsageExtraCard; readonly now: number }) {
  if (card.expiresAt === null) {
    return <span className="text-muted-foreground">No end date reported</span>;
  }
  const date = formatEndDate(card.expiresAt, now);
  if (card.expiresAt <= now) {
    return <span className="text-muted-foreground">Ended {date}</span>;
  }
  const soon = isExtraEndingSoon(card, now);
  return (
    <span className={cn(soon ? "font-medium text-warning-foreground" : "text-muted-foreground")}>
      {card.origin === "automatic" && (card.remaining ?? 0) > 1 ? "Next ends" : "Ends"} {date} ·{" "}
      {formatCountdown(card.expiresAt, now)}
    </span>
  );
}

function RedeemCredit({ redeem }: { readonly redeem: NonNullable<LimitAccount["redeem"]> }) {
  const {
    canManageProviders,
    confirming,
    setConfirming,
    busy,
    status,
    redeem: run,
  } = useResetCredit(redeem.environmentId, redeem.input);
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        disabled={busy || !canManageProviders}
        onClick={() => {
          if (readEnvironmentScope(redeem.environmentId, AuthProvidersManageScope)) {
            setConfirming(true);
          }
        }}
      >
        {busy ? "Using…" : "Use one"}
      </Button>
      {status ? <span className="text-2xs text-foreground">{status}</span> : null}
      <ResetCreditDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => void run()}
        disabled={!canManageProviders}
      />
    </>
  );
}

function ExtraCard({
  card,
  now,
  onRemove,
}: {
  readonly card: UsageExtraCard;
  readonly now: number;
  readonly onRemove: ((card: UsageExtraCard) => void) | null;
}) {
  const ended = card.expiresAt !== null && card.expiresAt <= now;
  return (
    <li
      className={cn(
        "relative flex w-60 shrink-0 snap-start flex-col gap-1 rounded-lg border border-border/70 bg-card/40 p-3 text-xs",
        isExtraEndingSoon(card, now) && "border-warning/60",
        ended && "opacity-60",
      )}
      aria-label={`${card.service}: ${card.title}`}
    >
      <span className="flex items-center gap-1.5 pe-6 text-muted-foreground">
        <span className="truncate">{card.service}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0">
          {card.origin === "automatic" ? "Read automatically" : "Added by you"}
        </span>
      </span>
      <span className="truncate text-sm font-medium text-foreground">{card.title}</span>
      <span className="text-foreground tabular-nums">
        {card.remaining === null ? "No count" : `${card.remaining.toLocaleString("en-US")} left`}
        {card.detail ? <span className="text-muted-foreground"> · {card.detail}</span> : null}
      </span>
      <span className="tabular-nums">
        <EndsLine card={card} now={now} />
      </span>
      {card.account?.redeem && !ended ? (
        <span className="mt-1 flex flex-wrap items-center gap-2">
          <RedeemCredit redeem={card.account.redeem} />
        </span>
      ) : null}
      {onRemove && card.manualId ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          className="absolute end-1.5 top-1.5"
          aria-label={`Remove ${card.title}`}
          onClick={() => onRemove(card)}
        >
          <XIcon />
        </Button>
      ) : null}
    </li>
  );
}

function AddExtraDialog({
  open,
  onOpenChange,
  environmentId,
  homeLabel,
  now,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly homeLabel: string | null;
  readonly now: number;
}) {
  const id = useId();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [draft, setDraft] = useState(EMPTY_USAGE_EXTRA_DRAFT);
  const extra = usageExtraFromDraft(draft, now);
  const edit =
    (field: keyof typeof draft) => (event: { readonly target: { readonly value: string } }) =>
      setDraft((current) => ({ ...current, [field]: event.target.value }));
  const close = () => {
    setDraft(EMPTY_USAGE_EXTRA_DRAFT);
    onOpenChange(false);
  };
  const save = () => {
    if (!extra) return;
    updateSettings({ usageExtras: { [newUsageExtraId(Date.now())]: extra } });
    close();
  };
  const today = new Date(now);
  const minDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add an extra</DialogTitle>
          <DialogDescription>
            Track a plan perk that ends on a date, such as free generations or an unlimited model.
            You get a reminder three days and one day before it ends.
            {homeLabel ? ` Saved on ${homeLabel}.` : null}
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
              <Label htmlFor={`${id}-service`}>Service</Label>
              <Input
                id={`${id}-service`}
                list={`${id}-services`}
                placeholder="Higgsfield"
                value={draft.service}
                onChange={edit("service")}
              />
              <datalist id={`${id}-services`}>
                {USAGE_EXTRA_SERVICE_SUGGESTIONS.map((service) => (
                  <option key={service} value={service} />
                ))}
              </datalist>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-title`}>What it is</Label>
              <Input
                id={`${id}-title`}
                placeholder="AI Influencer free generations"
                value={draft.title}
                onChange={edit("title")}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-remaining`}>Left (optional)</Label>
                <Input
                  id={`${id}-remaining`}
                  inputMode="numeric"
                  placeholder="Unlimited"
                  value={draft.remaining}
                  onChange={edit("remaining")}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-ends`}>Ends on</Label>
                <Input
                  id={`${id}-ends`}
                  type="date"
                  min={minDate}
                  value={draft.endsOn}
                  onChange={edit("endsOn")}
                />
              </div>
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!extra}>
            Add extra
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Plan perks with an end date, ending soonest first. Swipe or scroll sideways, or focus the strip
 * and use the arrow keys.
 */
export function UsageExtrasCarousel({
  cards,
  now,
  home,
  homeLabel,
  saveBlocked,
  focusRequestId,
}: {
  readonly cards: readonly UsageExtraCard[];
  readonly now: number;
  readonly home: EnvironmentId | null;
  readonly homeLabel: string | null;
  readonly saveBlocked: string | null;
  /** Changes when the composer's Extras button asks for this strip. */
  readonly focusRequestId: number;
}) {
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const stripRef = useRef<HTMLUListElement>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<UsageExtraCard | null>(null);
  const updateSettings = useUpdateEnvironmentSettings(home);
  const endingSoon = cards.filter((card) => isExtraEndingSoon(card, now)).length;

  useEffect(() => {
    if (focusRequestId === 0) return;
    stripRef.current?.focus({ preventScroll: true });
    // A frame later the drawer has grown to fit what it can, so this scrolls only what is left.
    // Not cancelled on cleanup: the request is consumed, and so cleared, before the frame.
    requestAnimationFrame(() =>
      sectionRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  }, [focusRequestId]);

  const step = (direction: 1 | -1) => {
    const strip = stripRef.current;
    const card = strip?.querySelector("li");
    if (!strip || !card) return;
    strip.scrollBy({
      left: direction * (card.getBoundingClientRect().width + 8),
      behavior: "smooth",
    });
  };

  return (
    <section ref={sectionRef} aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3
          id={headingId}
          className="flex items-center gap-1.5 text-xs font-medium text-foreground"
        >
          <GiftIcon className="size-3.5 text-muted-foreground" aria-hidden />
          Extras
        </h3>
        {endingSoon > 0 ? (
          <span className="text-2xs font-medium text-warning-foreground">
            {endingSoon} {endingSoon === 1 ? "ends" : "end"} within 3 days
          </span>
        ) : null}
        <span className="ms-auto flex items-center gap-1">
          {cards.length > 1 ? (
            <>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Previous extra"
                onClick={() => step(-1)}
              >
                <ChevronLeftIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Next extra"
                onClick={() => step(1)}
              >
                <ChevronRightIcon />
              </Button>
            </>
          ) : null}
          {saveBlocked ? (
            <Tooltip>
              <TooltipTrigger render={<span tabIndex={0} />}>
                <Button size="xs" variant="outline" disabled>
                  <PlusIcon aria-hidden />
                  Add extra
                </Button>
              </TooltipTrigger>
              <TooltipPopup side="top">{saveBlocked}</TooltipPopup>
            </Tooltip>
          ) : (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon aria-hidden />
              Add extra
            </Button>
          )}
        </span>
      </div>
      {cards.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No extras yet. Add a plan perk with an end date, such as free generations, and get a
          reminder before it ends. Banked Codex resets show here on their own.
        </p>
      ) : (
        <ul
          ref={stripRef}
          tabIndex={0}
          aria-label="Extras, use the arrow keys to move"
          className="flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain pb-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset rounded-lg"
          onKeyDown={(event) => {
            if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
            event.preventDefault();
            step(event.key === "ArrowRight" ? 1 : -1);
          }}
        >
          {cards.map((card) => (
            <ExtraCard
              key={card.key}
              card={card}
              now={now}
              onRemove={saveBlocked ? null : setRemoving}
            />
          ))}
        </ul>
      )}
      {home !== null && !saveBlocked ? (
        <AddExtraDialog
          open={adding}
          onOpenChange={setAdding}
          environmentId={home}
          homeLabel={homeLabel}
          now={now}
        />
      ) : null}
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this extra?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing ? `${removing.service}: ${removing.title}. ` : null}Its reminders stop too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                if (removing?.manualId) {
                  updateSettings({ usageExtras: { [removing.manualId]: null } });
                }
                setRemoving(null);
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
