import { describe, expect, it } from "@effect/vitest";
import { UsageLimitSourceError, UsageLimitSourceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  HIGGSFIELD_NOT_CONNECTED_MESSAGE,
  HIGGSFIELD_RECONNECT_MESSAGE,
  makeHiggsfieldApi,
  type SaveRefreshToken,
} from "./higgsfieldApi.ts";

const id = UsageLimitSourceId.make("higgsfield");
const config = {
  kind: "higgsfield",
  clientId: "client-1",
  refreshToken: "refresh-1",
  enabled: true,
} as const;

interface Answers {
  readonly token?: () => { status?: number; body: unknown };
  readonly balance?: unknown;
  readonly transactions?: (cursor: number | undefined) => unknown;
}

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

function higgsfieldAnswering(answers: Answers) {
  const log: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      if (url.pathname === "/oauth/token") {
        log.push(`token:${new URLSearchParams(body).get("refresh_token")}`);
        const { status = 200, body: answer } = answers.token?.() ?? {
          body: { access_token: "access-1", expires_in: 86_399 },
        };
        return HttpClientResponse.fromWeb(request, Response.json(answer, { status }));
      }
      const message = JSON.parse(body) as {
        id?: number;
        method: string;
        params?: { name?: string; arguments?: { cursor?: number } };
      };
      const name = message.params?.name;
      log.push(name ? `tool:${name}` : `mcp:${message.method}`);
      if (message.id === undefined) {
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 202 }));
      }
      const result =
        name === "balance"
          ? (answers.balance ?? text("Credits: 40 | Plan: plus"))
          : name === "transactions"
            ? (answers.transactions?.(message.params?.arguments?.cursor) ?? text("[]"))
            : { serverInfo: { name: "higgsfield" } };
      // Streamable HTTP may answer as an event stream.
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
          {
            headers: { "content-type": "text/event-stream", "mcp-session-id": "session-1" },
          },
        ),
      );
    }),
  );
  return { log, api: makeHiggsfieldApi.pipe(Effect.provideService(HttpClient.HttpClient, http)) };
}

const savingTo = (log: string[], outcome: () => Effect.Effect<boolean, UsageLimitSourceError>) =>
  ((previous, next) =>
    Effect.suspend(() => {
      log.push(`save:${previous}->${next}`);
      return outcome();
    })) satisfies SaveRefreshToken;

const saved = () => Effect.succeed(true);

const transactions = (cursor: number | undefined) =>
  text(
    JSON.stringify(
      cursor === undefined
        ? {
            items: [
              {
                display_name: "Kling video",
                credits: -30,
                action: "spend",
                created_at: "2026-02-10T09:00:00Z",
              },
              {
                display_name: "Daily Credits",
                credits: 5,
                action: "grant",
                created_at: "2026-02-05T00:00:00Z",
              },
              {
                display_name: "Failed job",
                credits: 10,
                action: "refund",
                created_at: "2026-02-03T00:00:00Z",
              },
            ],
            next_cursor: 2,
          }
        : {
            items: [
              {
                display_name: "Image",
                credits: -45,
                action: "spend",
                created_at: "2026-02-01T00:00:00Z",
              },
              {
                display_name: "Subscription Credits",
                credits: 100,
                action: "grant",
                created_at: "2026-01-31T10:00:00Z",
              },
              {
                display_name: "Subscription Credits",
                credits: 100,
                action: "grant",
                created_at: "2025-12-31T10:00:00Z",
              },
            ],
            next_cursor: 3,
          },
    ),
  );

describe("Higgsfield credits", () => {
  it.effect("estimates the monthly allowance and reset from the last subscription grant", () =>
    Effect.gen(function* () {
      const { api, log } = higgsfieldAnswering({ transactions });
      const [account] = yield* (yield* api).readAccounts(id, config, savingTo(log, saved));
      expect(account).toMatchObject({ id: "Higgsfield", driver: "higgsfield", plan: "plus" });
      expect(account?.usageLimits.windows).toEqual([
        {
          id: "credits",
          kind: "monthly",
          label: "Higgsfield credits (reset estimated)",
          remaining: 40,
          limit: 115,
          usedPercent: (75 / 115) * 100,
          unit: "credits",
          estimated: true,
          // A calendar month after Jan 31 is the last day of February.
          resetsAt: "2026-02-28T10:00:00.000Z",
        },
      ]);
      // Paging stops at the page holding the grant.
      expect(log.filter((entry) => entry === "tool:transactions")).toHaveLength(2);
    }),
  );

  it.effect("reads structuredContent and leaves the allowance unknown without a grant", () =>
    Effect.gen(function* () {
      const { api, log } = higgsfieldAnswering({
        balance: { structuredContent: { credits: 12, plan: "pro" }, content: [] },
        transactions: () => ({ structuredContent: { transactions: [], next_cursor: null } }),
      });
      const [account] = yield* (yield* api).readAccounts(id, config, savingTo(log, saved));
      expect(account?.plan).toBe("pro");
      expect(account?.usageLimits.windows).toEqual([
        {
          id: "credits",
          kind: "monthly",
          label: "Higgsfield credits (reset estimated)",
          remaining: 12,
          usedPercent: 0,
          unit: "credits",
        },
      ]);
    }),
  );

  it.effect("persists a rotated refresh token before using its access token", () =>
    Effect.gen(function* () {
      const { api, log } = higgsfieldAnswering({
        token: () => ({
          body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 86_399 },
        }),
      });
      const higgsfield = yield* api;
      yield* higgsfield.readAccounts(id, config, savingTo(log, saved));
      expect(log.slice(0, 3)).toEqual([
        "token:refresh-1",
        "save:refresh-1->refresh-2",
        "mcp:initialize",
      ]);

      // The saved token comes back as config; the cached access token is still good.
      log.length = 0;
      yield* higgsfield.readAccounts(
        id,
        { ...config, refreshToken: "refresh-2" },
        savingTo(log, saved),
      );
      expect(log.some((entry) => entry.startsWith("token:"))).toBe(false);

      yield* TestClock.adjust("86340 seconds");
      yield* higgsfield.readAccounts(
        id,
        { ...config, refreshToken: "refresh-2" },
        savingTo(log, saved),
      );
      expect(log).toContain("token:refresh-2");
    }),
  );

  it.effect("keeps a rotated token in memory when saving fails and retries the save", () =>
    Effect.gen(function* () {
      const { api, log } = higgsfieldAnswering({
        token: () => ({
          body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 86_399 },
        }),
      });
      const higgsfield = yield* api;
      const [failed] = yield* higgsfield.readAccounts(
        id,
        config,
        savingTo(log, () => Effect.fail(new UsageLimitSourceError({ detail: "Disk full." }))),
      );
      expect(failed?.usageLimits.unavailable).toEqual({
        reason: "probeFailed",
        message: "Disk full.",
      });
      expect(log).toEqual(["token:refresh-1", "save:refresh-1->refresh-2"]);

      log.length = 0;
      const [account] = yield* higgsfield.readAccounts(id, config, savingTo(log, saved));
      expect(log.slice(0, 2)).toEqual(["save:refresh-1->refresh-2", "mcp:initialize"]);
      expect(account?.usageLimits.windows[0]?.remaining).toBe(40);
    }),
  );

  it.effect("asks to reconnect when Higgsfield refuses the refresh token", () =>
    Effect.gen(function* () {
      const { api, log } = higgsfieldAnswering({
        token: () => ({ status: 400, body: { error: "invalid_grant" } }),
      });
      const [account] = yield* (yield* api).readAccounts(id, config, savingTo(log, saved));
      expect(account?.usageLimits.unavailable).toEqual({
        reason: "unsupported",
        message: HIGGSFIELD_RECONNECT_MESSAGE,
      });
    }),
  );

  it.effect("says it is not connected before the first sign-in", () =>
    Effect.gen(function* () {
      const { api, log } = higgsfieldAnswering({});
      const [account] = yield* (yield* api).readAccounts(
        id,
        { ...config, refreshToken: "" },
        savingTo(log, saved),
      );
      expect(account?.usageLimits.unavailable?.message).toBe(HIGGSFIELD_NOT_CONNECTED_MESSAGE);
      expect(log).toEqual([]);
    }),
  );
});
