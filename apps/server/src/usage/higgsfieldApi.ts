import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type HiggsfieldUsageLimitSourceConfig,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  type UsageLimitSourceId,
} from "@t3tools/contracts";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import { HIGGSFIELD_MCP_URL, makeHiggsfieldAuth } from "./higgsfieldAuth.ts";
import { nonNegative, usedPercentOf } from "./sourceHttp.ts";

const HIGGSFIELD_DRIVER = ProviderDriverKind.make("higgsfield");
const MCP_PROTOCOL_VERSION = "2025-06-18";
const ACCESS_TOKEN_MARGIN_MS = 60_000;
const TRANSACTION_PAGE_SIZE = 100;
// A monthly subscription grant is normally on the first page; this only bounds a long history.
const TRANSACTION_PAGE_LIMIT = 10;

export const HIGGSFIELD_RECONNECT_MESSAGE =
  "Sign-in expired. Reconnect Higgsfield in Settings → Usage.";
export const HIGGSFIELD_NOT_CONNECTED_MESSAGE =
  "Not connected yet. Connect Higgsfield in Settings → Usage.";

/**
 * Writes a rotated refresh token over `previous`. Resolves false when the stored token is no
 * longer `previous` because the user reconnected meanwhile; that sign-in wins.
 */
export type SaveRefreshToken = (
  previous: string,
  next: string,
) => Effect.Effect<boolean, UsageLimitSourceError>;

interface AccessToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

/**
 * `basedOn` is the stored refresh token this session came from; a different stored token means
 * the user reconnected. `unsaved` holds a rotated token whose write failed, so it is retried
 * instead of lost: Higgsfield has already retired the token it replaced.
 */
interface Session {
  readonly basedOn: string;
  readonly access?: AccessToken;
  readonly unsaved?: { readonly refreshToken: string; readonly access: AccessToken };
}

export interface HiggsfieldTransaction {
  readonly displayName: string;
  readonly credits: number;
  readonly action: string;
  readonly createdAtMs: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberOf = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const amount = Number(value.replace(/[,\s]/g, ""));
  return value.trim() !== "" && Number.isFinite(amount) ? amount : null;
};

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const timeOf = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

interface ToolResult {
  readonly structuredContent?: unknown;
  readonly content?: ReadonlyArray<unknown>;
  readonly isError?: boolean;
}

const toolText = (result: ToolResult) =>
  (result.content ?? [])
    .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join("\n");

/** structuredContent when the server sends it, otherwise JSON inside the text part. */
const toolObject = (result: ToolResult): unknown => {
  if (result.structuredContent !== undefined) return result.structuredContent;
  try {
    return JSON.parse(toolText(result));
  } catch {
    return undefined;
  }
};

/** Accepts `structuredContent` and the plain text Higgsfield sends today, "Credits: 4 | Plan: plus". */
export function parseBalance(
  result: ToolResult,
): { readonly credits: number; readonly plan: string | undefined } | null {
  const structured = toolObject(result);
  if (isRecord(structured)) {
    const credits = numberOf(
      structured.credits ?? structured.balance ?? structured.available_credits,
    );
    if (credits !== null) {
      return {
        credits,
        plan: stringOf(structured.plan ?? structured.plan_name ?? structured.subscription_plan),
      };
    }
  }
  const text = toolText(result);
  const credits = numberOf(/credits?\s*:\s*(-?[\d.,]+)/i.exec(text)?.[1]);
  if (credits === null) return null;
  return { credits, plan: stringOf(/plan\s*:\s*([^|\n]+)/i.exec(text)?.[1]) };
}

export function parseTransactionPage(result: ToolResult): {
  readonly items: ReadonlyArray<HiggsfieldTransaction>;
  readonly nextCursor: number | null;
} | null {
  const page = toolObject(result);
  const list = Array.isArray(page)
    ? page
    : isRecord(page)
      ? [page.transactions, page.items, page.data, page.results].find(Array.isArray)
      : undefined;
  if (!list) return null;
  const items = list.flatMap((item): HiggsfieldTransaction[] => {
    if (!isRecord(item)) return [];
    const credits = numberOf(item.credits ?? item.amount);
    if (credits === null) return [];
    return [
      {
        displayName: stringOf(item.display_name ?? item.name) ?? "",
        credits,
        action: (stringOf(item.action ?? item.type) ?? "").toLowerCase(),
        createdAtMs: timeOf(item.created_at),
      },
    ];
  });
  const cursor = isRecord(page) ? numberOf(page.next_cursor) : null;
  return { items, nextCursor: cursor };
}

const isSubscriptionGrant = (item: HiggsfieldTransaction) =>
  item.action === "grant" && /subscription/i.test(item.displayName);

/**
 * Higgsfield reports only the balance. The monthly allowance is the last subscription grant
 * plus grants and refunds since (daily credits, for example), and the reset is a calendar month
 * after that grant, so both are estimates.
 */
export function creditsWindow(
  remaining: number,
  newestFirst: ReadonlyArray<HiggsfieldTransaction>,
): ServerProviderUsageWindow {
  const base = {
    id: "credits",
    kind: "monthly",
    label: "Higgsfield credits (reset estimated)",
    remaining: nonNegative(remaining),
    unit: "credits",
  } as const;
  const grantIndex = newestFirst.findIndex(isSubscriptionGrant);
  const grant = newestFirst[grantIndex];
  if (!grant) return { ...base, usedPercent: 0 };
  const topUps = newestFirst
    .slice(0, grantIndex)
    .filter((item) => item.action === "grant" || item.action === "refund")
    .reduce((sum, item) => sum + Math.abs(item.credits), 0);
  const limit = Math.abs(grant.credits) + topUps;
  return {
    ...base,
    usedPercent: usedPercentOf(limit - base.remaining, limit),
    limit,
    estimated: true,
    ...(grant.createdAtMs === null
      ? {}
      : {
          // DateTime clamps to the month's last day, so a Jan 31 grant resets on Feb 28.
          resetsAt: DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(grant.createdAtMs), { months: 1 }),
          ),
        }),
  };
}

class McpUnauthorized extends Data.TaggedError("McpUnauthorized")<{}> {}

/** Streamable HTTP answers either with JSON or with an SSE stream carrying the response. */
function parseRpcResponse(text: string, id: number): unknown {
  const messages = text.trimStart().startsWith("{")
    ? [text]
    : text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
  for (const message of messages) {
    try {
      const parsed: unknown = JSON.parse(message);
      if (isRecord(parsed) && parsed.id === id) return parsed;
    } catch {}
  }
  return undefined;
}

export const makeHiggsfieldApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const auth = yield* makeHiggsfieldAuth;
  const sessions = yield* Ref.make(new Map<UsageLimitSourceId, Session>());

  const setSession = (id: UsageLimitSourceId, session: Session | undefined) =>
    Ref.update(sessions, (current) => {
      const next = new Map(current);
      if (session) next.set(id, session);
      else next.delete(id);
      return next;
    });

  const accessToken = Effect.fn("HiggsfieldApi.accessToken")(function* (
    id: UsageLimitSourceId,
    config: HiggsfieldUsageLimitSourceConfig,
    save: SaveRefreshToken,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const cached = (yield* Ref.get(sessions)).get(id);
    let session: Session =
      cached && cached.basedOn === config.refreshToken ? cached : { basedOn: config.refreshToken };

    if (session.unsaved) {
      const { unsaved } = session;
      if (!(yield* save(session.basedOn, unsaved.refreshToken))) {
        yield* setSession(id, undefined);
        return yield* new UsageLimitSourceError({ detail: "Higgsfield was just reconnected." });
      }
      session = { basedOn: unsaved.refreshToken, access: unsaved.access };
      yield* setSession(id, session);
    }
    if (session.access && now < session.access.expiresAtMs - ACCESS_TOKEN_MARGIN_MS) {
      return session.access.token;
    }

    const tokens = yield* auth.refresh({
      clientId: config.clientId,
      refreshToken: session.basedOn,
    });
    const access = { token: tokens.accessToken, expiresAtMs: now + tokens.expiresInSeconds * 1000 };
    if (tokens.refreshToken === undefined || tokens.refreshToken === session.basedOn) {
      yield* setSession(id, { basedOn: session.basedOn, access });
      return access.token;
    }
    // The rotated token is persisted before its access token is used; if the write fails the
    // stored token stays as it was and the new one waits in memory for the next attempt.
    yield* setSession(id, {
      basedOn: session.basedOn,
      unsaved: { refreshToken: tokens.refreshToken, access },
    });
    if (!(yield* save(session.basedOn, tokens.refreshToken))) {
      yield* setSession(id, undefined);
      return yield* new UsageLimitSourceError({ detail: "Higgsfield was just reconnected." });
    }
    yield* setSession(id, { basedOn: tokens.refreshToken, access });
    return access.token;
  });

  const mcpFailed = (error: unknown): McpUnauthorized | UsageLimitSourceError => {
    if (error instanceof McpUnauthorized) return error;
    if (Cause.isTimeoutError(error)) {
      return new UsageLimitSourceError({ detail: "Higgsfield did not answer within 15 seconds." });
    }
    if (HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError") {
      return new UsageLimitSourceError({
        detail: `Higgsfield answered with HTTP ${error.reason.response.status}.`,
      });
    }
    return new UsageLimitSourceError({ detail: "The Higgsfield request failed." });
  };

  const readWithToken = Effect.fn("HiggsfieldApi.readWithToken")(function* (token: string) {
    let sessionId: string | undefined;
    let nextId = 1;
    const post = (message: Record<string, unknown>) =>
      client
        .execute(
          HttpClientRequest.post(HIGGSFIELD_MCP_URL).pipe(
            HttpClientRequest.setHeaders({
              authorization: `Bearer ${token}`,
              accept: "application/json, text/event-stream",
              ...(sessionId === undefined
                ? {}
                : { "mcp-session-id": sessionId, "mcp-protocol-version": MCP_PROTOCOL_VERSION }),
            }),
            HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", ...message }),
          ),
        )
        .pipe(
          Effect.filterOrFail(
            (response) => response.status !== 401,
            () => new McpUnauthorized(),
          ),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.tap((response) =>
            Effect.sync(() => {
              sessionId = response.headers["mcp-session-id"] ?? sessionId;
            }),
          ),
          Effect.flatMap((response) => response.text),
          Effect.timeout("15 seconds"),
          Effect.mapError(mcpFailed),
        );
    const request = (method: string, params: Record<string, unknown>) =>
      Effect.gen(function* () {
        const id = nextId++;
        const response = parseRpcResponse(yield* post({ id, method, params }), id);
        if (!isRecord(response) || !isRecord(response.result)) {
          return yield* new UsageLimitSourceError({
            detail: `Higgsfield could not answer ${method === "tools/call" ? String(params.name) : method}.`,
          });
        }
        return response.result as ToolResult;
      });
    const callTool = (name: string, args: Record<string, unknown>) =>
      request("tools/call", { name, arguments: args }).pipe(
        Effect.filterOrFail(
          (result) => result.isError !== true,
          () => new UsageLimitSourceError({ detail: `Higgsfield refused the ${name} request.` }),
        ),
      );

    yield* request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "t3-code-usage", version: "1" },
    });
    yield* post({ method: "notifications/initialized" });

    const balance = parseBalance(yield* callTool("balance", {}));
    if (!balance) {
      return yield* new UsageLimitSourceError({
        detail: "Higgsfield returned an unexpected balance.",
      });
    }

    const history = yield* Effect.gen(function* () {
      const items: HiggsfieldTransaction[] = [];
      let cursor: number | null = null;
      for (let page = 0; page < TRANSACTION_PAGE_LIMIT; page++) {
        const parsed = parseTransactionPage(
          yield* callTool("transactions", {
            size: TRANSACTION_PAGE_SIZE,
            ...(cursor === null ? {} : { cursor }),
          }),
        );
        if (!parsed) return null;
        items.push(...parsed.items);
        cursor = parsed.nextCursor;
        if (cursor === null || parsed.items.some(isSubscriptionGrant)) break;
      }
      return items;
    }).pipe(Effect.catchTags({ UsageLimitSourceError: () => Effect.succeed(null) }));
    return { balance, history };
  });

  const readAccounts = Effect.fn("HiggsfieldApi.readAccounts")(function* (
    id: UsageLimitSourceId,
    config: HiggsfieldUsageLimitSourceConfig,
    save: SaveRefreshToken,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const account = { id: config.label ?? "Higgsfield", driver: HIGGSFIELD_DRIVER };
    const unavailable = (reason: "unsupported" | "probeFailed", message: string) =>
      DateTime.now.pipe(
        Effect.map((now) => [
          {
            ...account,
            usageLimits: makeUnavailableUsageLimits({
              checkedAt: DateTime.formatIso(now),
              reason,
              message,
            }),
          },
        ]),
      );
    if (!config.clientId || !config.refreshToken) {
      return yield* unavailable("unsupported", HIGGSFIELD_NOT_CONNECTED_MESSAGE);
    }

    const read = accessToken(id, config, save).pipe(Effect.flatMap(readWithToken));
    const outcome = yield* read.pipe(
      // An access token can be revoked before it expires; one fresh token is worth a retry.
      Effect.catchTags({
        McpUnauthorized: () =>
          Ref.update(sessions, (current) => {
            const next = new Map(current);
            const session = next.get(id);
            if (session) next.set(id, { basedOn: session.basedOn });
            return next;
          }).pipe(Effect.andThen(read)),
      }),
      Effect.result,
    );
    if (outcome._tag === "Failure") {
      const error = outcome.failure;
      if (error._tag === "HiggsfieldSignInExpired") {
        yield* setSession(id, undefined);
        return yield* unavailable("unsupported", HIGGSFIELD_RECONNECT_MESSAGE);
      }
      if (error._tag === "McpUnauthorized") {
        return yield* unavailable("probeFailed", "Higgsfield refused the sign-in.");
      }
      return yield* unavailable("probeFailed", error.detail);
    }

    const { balance, history } = outcome.success;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return [
      {
        ...account,
        ...(balance.plan ? { plan: balance.plan } : {}),
        usageLimits: {
          checkedAt,
          windows: [creditsWindow(balance.credits, history ?? [])],
          ...(history === null
            ? {
                notice: "Could not read the credit history, so the monthly allowance is unknown.",
              }
            : {}),
        },
      },
    ];
  });

  return { readAccounts };
});
