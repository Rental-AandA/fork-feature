import {
  UsageLimitSourceError,
  type HiggsfieldUsageLimitSourceConfig,
  type UsageLimitSourceConnectInput,
  type UsageLimitSourceConnectResult,
  type UsageLimitSourceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../config.ts";
import * as Settings from "../serverSettings.ts";
import {
  HIGGSFIELD_CALLBACK_PATH,
  higgsfieldAuthorizeUrl,
  makeHiggsfieldAuth,
  makePkce,
} from "./higgsfieldAuth.ts";

const PENDING_TTL_MS = 10 * 60_000;

interface PendingSignIn {
  readonly sourceId: UsageLimitSourceId;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly verifier: string;
  readonly expiresAtMs: number;
}

export interface HiggsfieldCallbackQuery {
  readonly state?: string | undefined;
  readonly code?: string | undefined;
  readonly error?: string | undefined;
}

export class HiggsfieldConnect extends Context.Service<
  HiggsfieldConnect,
  {
    readonly start: (
      input: UsageLimitSourceConnectInput,
    ) => Effect.Effect<UsageLimitSourceConnectResult, UsageLimitSourceError>;
    readonly complete: (
      query: HiggsfieldCallbackQuery,
    ) => Effect.Effect<void, UsageLimitSourceError>;
  }
>()("t3/usage/HiggsfieldConnect") {}

const settingsFailed = () =>
  new UsageLimitSourceError({ detail: "Could not save the Higgsfield source settings." });

/**
 * PKCE verifiers and states live only in memory: a server restart ends sign-ins in progress,
 * which the user restarts from settings.
 */
export const make = Effect.gen(function* () {
  const auth = yield* makeHiggsfieldAuth;
  const settings = yield* Settings.ServerSettingsService;
  const { port } = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const pending = yield* Ref.make(new Map<string, PendingSignIn>());

  const readSource = (sourceId: UsageLimitSourceId) =>
    settings.getSettings.pipe(
      Effect.mapError(settingsFailed),
      Effect.map((current) => current.usageLimitSources[sourceId]),
    );
  const writeSource = (sourceId: UsageLimitSourceId, config: HiggsfieldUsageLimitSourceConfig) =>
    settings
      .updateSettings({ usageLimitSources: { [sourceId]: config } })
      .pipe(Effect.mapError(settingsFailed), Effect.asVoid);

  const start = Effect.fn("HiggsfieldConnect.start")(function* (
    input: UsageLimitSourceConnectInput,
  ) {
    if (!port) {
      return yield* new UsageLimitSourceError({
        detail: "This server has no local port for the Higgsfield sign-in to return to.",
      });
    }
    const redirectUri = `http://127.0.0.1:${port}${HIGGSFIELD_CALLBACK_PATH}`;
    const existing = yield* readSource(input.sourceId);
    if (existing && existing.kind !== "higgsfield") {
      return yield* new UsageLimitSourceError({
        detail: "That source is not a Higgsfield source.",
      });
    }
    if (!existing) {
      // Saved before sign-in so an abandoned sign-in leaves a source that says it needs one.
      yield* writeSource(input.sourceId, {
        kind: "higgsfield",
        ...(input.label ? { label: input.label } : {}),
        clientId: "",
        refreshToken: "",
        enabled: true,
      });
    }
    // A registered client only accepts its own redirect, so a new server port needs a new one.
    // The new client id is saved with the sign-in, never alone: the stored refresh token belongs
    // to the old client and must keep working if this sign-in is abandoned.
    const clientId =
      existing?.clientId && existing.clientRedirectUri === redirectUri
        ? existing.clientId
        : yield* auth.registerClient(redirectUri);
    const pkce = yield* makePkce.pipe(
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.mapError(
        () => new UsageLimitSourceError({ detail: "Could not prepare the Higgsfield sign-in." }),
      ),
    );
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(pending, (current) => {
      const next = new Map([...current].filter(([, entry]) => entry.expiresAtMs > now));
      next.set(pkce.state, {
        sourceId: input.sourceId,
        clientId,
        redirectUri,
        verifier: pkce.verifier,
        expiresAtMs: now + PENDING_TTL_MS,
      });
      return next;
    });
    return {
      authorizeUrl: higgsfieldAuthorizeUrl({
        clientId,
        redirectUri,
        state: pkce.state,
        challenge: pkce.challenge,
      }),
    };
  });

  const complete = Effect.fn("HiggsfieldConnect.complete")(function* (
    query: HiggsfieldCallbackQuery,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const signIn = yield* Ref.modify(pending, (current) => {
      const entry = query.state ? current.get(query.state) : undefined;
      if (!entry || !query.state) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(query.state);
      return [entry, next] as const;
    });
    if (!signIn || signIn.expiresAtMs <= now) {
      return yield* new UsageLimitSourceError({
        detail: "This sign-in link expired or was already used. Start again from Settings → Usage.",
      });
    }
    if (query.error || !query.code) {
      return yield* new UsageLimitSourceError({
        detail: "Higgsfield sign-in was cancelled. Start again from Settings → Usage.",
      });
    }
    const tokens = yield* auth.exchangeCode({
      clientId: signIn.clientId,
      redirectUri: signIn.redirectUri,
      code: query.code,
      verifier: signIn.verifier,
    });
    if (!tokens.refreshToken) {
      return yield* new UsageLimitSourceError({
        detail: "Higgsfield did not allow staying signed in. Try connecting again.",
      });
    }
    const source = yield* readSource(signIn.sourceId);
    if (!source || source.kind !== "higgsfield") {
      return yield* new UsageLimitSourceError({
        detail: "The Higgsfield source was removed while signing in.",
      });
    }
    yield* writeSource(signIn.sourceId, {
      ...source,
      clientId: signIn.clientId,
      clientRedirectUri: signIn.redirectUri,
      refreshToken: tokens.refreshToken,
      enabled: true,
    });
  });

  return { start, complete } satisfies HiggsfieldConnect["Service"];
});

export const layer = Layer.effect(HiggsfieldConnect, make);

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );

function callbackPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 32px 16px; }
      main { max-width: 28rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { margin: 0; opacity: 0.75; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(body)}</p>
    </main>
  </body>
</html>`;
}

export const routeLayer = HttpRouter.add(
  "GET",
  HIGGSFIELD_CALLBACK_PATH,
  Effect.gen(function* () {
    const connect = yield* HiggsfieldConnect;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const params = Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
    const result = yield* connect
      .complete({
        state: params.get("state") ?? undefined,
        code: params.get("code") ?? undefined,
        error: params.get("error") ?? undefined,
      })
      .pipe(Effect.result);
    const page =
      result._tag === "Success"
        ? callbackPage(
            "Higgsfield connected",
            "Your credits appear on the Usage page in T3 Code. You can close this window.",
          )
        : callbackPage("Higgsfield not connected", result.failure.detail);
    return HttpServerResponse.text(page, {
      contentType: "text/html",
      status: result._tag === "Success" ? 200 : 400,
      headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
  }),
);
