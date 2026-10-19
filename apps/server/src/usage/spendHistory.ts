import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const SpendEntry = Schema.Struct({
  /** UTC day of the last reading, `YYYY-MM-DD`. */
  day: Schema.String,
  balance: Schema.Number,
  spentDay: Schema.Number,
  spentMonth: Schema.Number,
});
const SpendHistoryFile = Schema.Record(Schema.String, SpendEntry);
export type SpendHistoryState = typeof SpendHistoryFile.Type;
const SpendHistoryJson = Schema.fromJsonString(SpendHistoryFile);
const decodeHistory = Schema.decodeUnknownEffect(SpendHistoryJson);
const encodeHistory = Schema.encodeEffect(SpendHistoryJson);

export interface DerivedSpend {
  readonly day: number;
  readonly month: number;
}

/**
 * For services that report a balance but no spend. A drop between two readings
 * is spend; a rise is a top-up and does not offset it. A drop seen across a day
 * or month boundary counts toward the new period, since the reading cannot
 * tell when it happened.
 */
export function recordBalance(
  state: SpendHistoryState,
  key: string,
  balance: number,
  day: string,
): { readonly state: SpendHistoryState; readonly spend: DerivedSpend } {
  const previous = state[key];
  const drop = previous ? Math.max(0, previous.balance - balance) : 0;
  const entry = {
    day,
    balance,
    spentDay: (previous?.day === day ? previous.spentDay : 0) + drop,
    spentMonth: (previous?.day.slice(0, 7) === day.slice(0, 7) ? previous.spentMonth : 0) + drop,
  };
  return {
    state: { ...state, [key]: entry },
    spend: { day: entry.spentDay, month: entry.spentMonth },
  };
}

/** A missing or unreadable file starts the history over rather than failing the read. */
export const makeSpendHistory = Effect.fn("makeSpendHistory")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const lock = yield* Semaphore.make(1);
  const record = (key: string, balance: number) =>
    Effect.gen(function* () {
      const state = yield* fs.readFileString(filePath).pipe(
        Effect.flatMap(decodeHistory),
        Effect.orElseSucceed((): SpendHistoryState => ({})),
      );
      const day = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
      const next = recordBalance(state, key, balance, day);
      yield* encodeHistory(next.state).pipe(
        Effect.flatMap((contents) => fs.writeFileString(filePath, `${contents}\n`)),
        Effect.ignore({ log: true }),
      );
      return next.spend;
    }).pipe(lock.withPermits(1));
  return { record };
});
