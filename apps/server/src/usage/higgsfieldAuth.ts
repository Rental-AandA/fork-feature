import { UsageLimitSourceError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

/**
 * Higgsfield's MCP server is the protected resource; Clerk is its authorization server. Device
 * flow is refused for dynamically registered clients, so sign-in is auth code + PKCE with a
 * loopback redirect to this server.
 */
export const HIGGSFIELD_AUTH_SERVER = "https://clerk.higgsfield.ai";
export const HIGGSFIELD_MCP_URL = "https://mcp.higgsfield.ai/mcp";
export const HIGGSFIELD_SCOPE = "openid email offline_access";
export const HIGGSFIELD_CALLBACK_PATH = "/oauth/higgsfield/callback";

/** The refresh token was refused, so only a new sign-in helps. */
export class HiggsfieldSignInExpired extends Data.TaggedError("HiggsfieldSignInExpired")<{}> {}

const Registration = Schema.Struct({ client_id: Schema.String.check(Schema.isNonEmpty()) });
const TokenResponse = Schema.Struct({
  access_token: Schema.String.check(Schema.isNonEmpty()),
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
});
const decodeRegistration = Schema.decodeUnknownEffect(Registration);
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);

export interface HiggsfieldTokens {
  readonly accessToken: string;
  /** Present when Higgsfield rotated it; the previous one must not be used again. */
  readonly refreshToken: string | undefined;
  readonly expiresInSeconds: number;
}

const requestFailed = (step: string) => (error: unknown) => {
  if (Cause.isTimeoutError(error)) {
    return new UsageLimitSourceError({ detail: `Higgsfield did not answer the ${step} in time.` });
  }
  if (HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError") {
    return new UsageLimitSourceError({
      detail: `Higgsfield refused the ${step} (HTTP ${error.reason.response.status}).`,
    });
  }
  return new UsageLimitSourceError({ detail: `The Higgsfield ${step} failed.` });
};

const decodeTokens = (body: unknown) =>
  decodeTokenResponse(body).pipe(
    Effect.map((tokens): HiggsfieldTokens => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || undefined,
      expiresInSeconds: tokens.expires_in ?? 3600,
    })),
    Effect.mapError(
      () => new UsageLimitSourceError({ detail: "Higgsfield returned an unexpected sign-in." }),
    ),
  );

export const makePkce = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const verifier = Base64Url.encode(yield* crypto.randomBytes(32));
  const challenge = Base64Url.encode(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const state = Base64Url.encode(yield* crypto.randomBytes(16));
  return { verifier, challenge, state };
});

export function higgsfieldAuthorizeUrl(input: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly challenge: string;
}): string {
  const url = new URL(`${HIGGSFIELD_AUTH_SERVER}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: HIGGSFIELD_SCOPE,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    resource: HIGGSFIELD_MCP_URL,
  })) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export const makeHiggsfieldAuth = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const postForm = (params: Record<string, string>) =>
    client
      .execute(
        HttpClientRequest.post(`${HIGGSFIELD_AUTH_SERVER}/oauth/token`).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
          HttpClientRequest.bodyUrlParams(params),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("15 seconds"),
      );

  const registerClient = (redirectUri: string) =>
    client
      .execute(
        HttpClientRequest.post(`${HIGGSFIELD_AUTH_SERVER}/oauth/register`).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
          HttpClientRequest.bodyJsonUnsafe({
            client_name: "T3 Code usage",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            redirect_uris: [redirectUri],
            scope: HIGGSFIELD_SCOPE,
          }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("15 seconds"),
        Effect.mapError(requestFailed("client registration")),
        Effect.flatMap((body) =>
          decodeRegistration(body).pipe(
            Effect.mapError(
              () =>
                new UsageLimitSourceError({
                  detail: "Higgsfield returned an unexpected client registration.",
                }),
            ),
          ),
        ),
        Effect.map((registration) => registration.client_id),
      );

  const exchangeCode = (input: {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly code: string;
    readonly verifier: string;
  }) =>
    postForm({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.verifier,
      resource: HIGGSFIELD_MCP_URL,
    }).pipe(Effect.mapError(requestFailed("sign-in")), Effect.flatMap(decodeTokens));

  const refresh = (input: { readonly clientId: string; readonly refreshToken: string }) =>
    postForm({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      resource: HIGGSFIELD_MCP_URL,
    }).pipe(
      Effect.mapError((error) =>
        HttpClientError.isHttpClientError(error) &&
        error.reason._tag === "StatusCodeError" &&
        (error.reason.response.status === 400 || error.reason.response.status === 401)
          ? new HiggsfieldSignInExpired()
          : requestFailed("token refresh")(error),
      ),
      Effect.flatMap(decodeTokens),
    );

  return { registerClient, exchangeCode, refresh };
});

export type HiggsfieldAuth = Effect.Success<typeof makeHiggsfieldAuth>;
