import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { makeSpendHistory, recordBalance } from "./spendHistory.ts";

describe("derived spend", () => {
  it("counts balance drops, ignores top-ups, and starts a new day and month over", () => {
    let state = {};
    const read = (balance: number, day: string) => {
      const next = recordBalance(state, "deepseek:USD", balance, day);
      state = next.state;
      return next.spend;
    };
    expect(read(10, "2026-10-30")).toEqual({ day: 0, month: 0 });
    expect(read(9, "2026-10-30")).toEqual({ day: 1, month: 1 });
    expect(read(19, "2026-10-30")).toEqual({ day: 1, month: 1 });
    expect(read(18.5, "2026-10-31")).toEqual({ day: 0.5, month: 1.5 });
    expect(read(18, "2026-11-01")).toEqual({ day: 0.5, month: 0.5 });
    expect(recordBalance(state, "deepseek:CNY", 50, "2026-11-01").spend).toEqual({
      day: 0,
      month: 0,
    });
  });

  it.effect("keeps readings in a file and starts over when it is unreadable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-usage-spend-" });
      const filePath = (yield* Path.Path).join(directory, "usage-spend.json");
      yield* TestClock.setTime(Date.parse("2026-10-20T08:00:00.000Z"));

      yield* (yield* makeSpendHistory(filePath)).record("source:USD", 12);
      // A fresh instance reads what the previous one wrote.
      const history = yield* makeSpendHistory(filePath);
      expect(yield* history.record("source:USD", 11.5)).toEqual({ day: 0.5, month: 0.5 });

      yield* fs.writeFileString(filePath, "not json");
      expect(yield* history.record("source:USD", 10)).toEqual({ day: 0, month: 0 });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
