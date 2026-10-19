import type { EnvironmentId, UsageLimitSourceConnectInput } from "@t3tools/contracts";
import { useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export type UsageSourceConnectState =
  | { readonly status: "idle" }
  | { readonly status: "starting" }
  | { readonly status: "waiting"; readonly authorizeUrl: string }
  | { readonly status: "failed"; readonly message: string };

const openSignIn = (url: string) =>
  ensureLocalApi()
    .shell.openExternal(url)
    .catch(() => undefined);

/**
 * Starts a browser sign-in for a usage source. The server finishes it on its loopback callback,
 * so the client only opens the page; credits then arrive with the next usage snapshot.
 */
export function useUsageSourceConnect(environmentId: EnvironmentId) {
  const connect = useAtomCommand(serverEnvironment.connectUsageLimitSource, {
    reportFailure: false,
  });
  const [state, setState] = useState<UsageSourceConnectState>({ status: "idle" });

  const start = async (input: UsageLimitSourceConnectInput) => {
    setState({ status: "starting" });
    const result = await connect({ environmentId, input });
    if (result._tag !== "Success") {
      setState({
        status: "failed",
        message:
          "error" in result.cause && result.cause.error instanceof Error
            ? result.cause.error.message
            : "Could not start the sign-in.",
      });
      return;
    }
    setState({ status: "waiting", authorizeUrl: result.value.authorizeUrl });
    // A browser may block a window opened after an await; the waiting state offers a direct link.
    await openSignIn(result.value.authorizeUrl);
  };

  const reopen = () => {
    if (state.status === "waiting") void openSignIn(state.authorizeUrl);
  };

  return { state, start, reopen, reset: () => setState({ status: "idle" }) };
}
