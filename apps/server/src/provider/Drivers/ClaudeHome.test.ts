import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PlatformError from "effect/PlatformError";

import {
  claudeSignedOutMessage,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("treats empty, ~/.claude, and the expanded default as the same Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(path.join(NodeOS.homedir(), ".claude"));

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: resolved })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);

        const key = `claude:home:${resolved}`;
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "~/.claude" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: resolved })).toBe(key);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect(
      "groups accounts whose projects folder resolves to the shared conversations path",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = path.resolve("/synthetic/users/aram");
          const shared = path.join(root, ".claude", "projects");
          // Stands in for the junctions ~/.claude_2/projects -> ~/.claude/projects.
          const links = new Map([
            [shared, shared],
            [path.join(root, ".claude_2", "projects"), shared],
            [path.join(root, ".claude_3", "projects"), path.join(root, ".claude_3", "projects")],
          ]);
          const fileSystem = FileSystem.makeNoop({
            realPath: (target) => {
              const resolved = links.get(target);
              return resolved === undefined
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "NotFound",
                      module: "FileSystem",
                      method: "realPath",
                      pathOrDescriptor: target,
                    }),
                  )
                : Effect.succeed(resolved);
            },
          });
          const keyFor = (
            homePath: string,
            sharedSessionsPath: string,
            platform: NodeJS.Platform = "linux",
          ) =>
            makeClaudeContinuationGroupKey({ homePath, sharedSessionsPath }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(HostProcess.Platform, platform),
            );
          const sharedKey = `claude:sessions:${shared}`;
          // Windows paths are case-insensitive, so every account derives the same key.
          expect(yield* keyFor(path.join(root, ".claude_2"), shared, "win32")).toBe(
            `claude:sessions:${shared.toLowerCase()}`,
          );
          expect(yield* keyFor(path.join(root, ".claude"), shared)).toBe(sharedKey);
          expect(yield* keyFor(path.join(root, ".claude_2"), shared)).toBe(sharedKey);
          // Not linked yet: the switch hands off context instead of resuming a missing transcript.
          const unlinked = path.join(root, ".claude_3");
          expect(yield* keyFor(unlinked, shared)).toBe(`claude:home:${unlinked}`);
          const missing = path.join(root, ".claude_4");
          expect(yield* keyFor(missing, shared)).toBe(`claude:home:${missing}`);
          expect(yield* keyFor(path.join(root, ".claude_2"), "")).toBe(
            `claude:home:${path.join(root, ".claude_2")}`,
          );
        }),
    );
  });
});
