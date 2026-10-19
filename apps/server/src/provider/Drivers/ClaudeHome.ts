import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

/**
 * While it exists Claude refuses `--strict-mcp-config` and exits before
 * initializing, but it already ignores user, project and `--mcp-config` servers
 * on its own, so callers that pass the flag for isolation can drop it. Paths
 * match the ones Claude Code checks.
 */
export const hasClaudeManagedMcpConfig = Effect.fn("hasClaudeManagedMcpConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const managedMcpConfigPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-mcp.json"
        : "/etc/claude-code/managed-mcp.json";
  return yield* fileSystem.exists(managedMcpConfigPath).pipe(Effect.orElseSucceed(() => false));
});

/**
 * Claude resumes a session from `<CLAUDE_CONFIG_DIR>/projects/<cwd>/<id>.jsonl`.
 * Accounts whose projects folder resolves to the same shared folder can resume
 * each other's sessions natively, so they share a continuation group. A shared
 * path that this home does not actually link to keeps the home key: the switch
 * then hands off context instead of resuming a transcript the CLI cannot find.
 */
export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath"> & Partial<Pick<ClaudeSettings, "sharedSessionsPath">>,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path | FileSystem.FileSystem> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    const homeKey = `claude:home:${resolvedHomePath}`;
    const sharedSessionsPath = config.sharedSessionsPath?.trim() ?? "";
    if (sharedSessionsPath.length === 0) return homeKey;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const sharedPath = path.resolve(
      expandHomePath(sharedSessionsPath, yield* HostProcess.HomeDirectory),
    );
    const realPathOf = (target: string) =>
      fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => null));
    const sharedRealPath = yield* realPathOf(sharedPath);
    const projectsRealPath = yield* realPathOf(path.join(resolvedHomePath, "projects"));
    // Windows paths compare case-insensitively; a differently typed drive letter is the same folder.
    const comparable =
      (yield* HostProcess.Platform) === "win32"
        ? (value: string) => value.toLowerCase()
        : (value: string) => value;
    if (
      sharedRealPath === null ||
      projectsRealPath === null ||
      comparable(sharedRealPath) !== comparable(projectsRealPath)
    ) {
      yield* Effect.logWarning("claude.shared-sessions.not-linked", {
        homePath: resolvedHomePath,
        sharedSessionsPath: sharedPath,
        projectsRealPath,
      });
      return homeKey;
    }
    return `claude:sessions:${comparable(sharedRealPath)}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/**
 * Describe the spawned CLI's environment separately from the login command so
 * paths remain literal on every shell, including relative inherited values.
 */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
