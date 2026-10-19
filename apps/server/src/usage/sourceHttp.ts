import { UsageLimitSourceError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

/**
 * Error bodies can echo request details such as the key, so only the status or
 * failure kind reaches the client.
 */
export const getSourceJson = (
  client: HttpClient.HttpClient,
  input: {
    readonly service: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly statusDetail?: (status: number) => string | undefined;
  },
) =>
  client
    .execute(HttpClientRequest.get(input.url).pipe(HttpClientRequest.setHeaders(input.headers)))
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout("15 seconds"),
      Effect.mapError((error) => {
        if (Cause.isTimeoutError(error)) {
          return new UsageLimitSourceError({
            detail: `${input.service} did not answer within 15 seconds.`,
          });
        }
        if (HttpClientError.isHttpClientError(error) && error.reason._tag === "StatusCodeError") {
          const status = error.reason.response.status;
          return new UsageLimitSourceError({
            detail:
              input.statusDetail?.(status) ?? `${input.service} answered with HTTP ${status}.`,
          });
        }
        return new UsageLimitSourceError({ detail: `The ${input.service} request failed.` });
      }),
    );

export const decodeSourceJson =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, service: string) =>
  (body: unknown) =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(
        () => new UsageLimitSourceError({ detail: `${service} returned an unexpected response.` }),
      ),
    );

/** Balances can go negative on some services, but windows only carry what is left. */
export const nonNegative = (value: number) => Math.max(0, value);

export const usedPercentOf = (used: number, limit: number) =>
  limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 100;
