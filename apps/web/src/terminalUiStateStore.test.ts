import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  drawerHeightOf,
  migratePersistedTerminalUiStateStoreState,
  selectThreadTerminalUiState,
  USAGE_DRAWER_MIN_HEIGHT,
  useTerminalUiStateStore,
} from "./terminalUiStateStore";
import { DEFAULT_THREAD_TERMINAL_HEIGHT, DEFAULT_THREAD_TERMINAL_ID } from "./types";

const THREAD_ID = ThreadId.make("thread-1");
const THREAD_REF = scopeThreadRef("environment-a" as never, THREAD_ID);
const OTHER_THREAD_REF = scopeThreadRef("environment-b" as never, THREAD_ID);

describe("terminalUiStateStore actions", () => {
  beforeEach(() => {
    useTerminalUiStateStore.persist.clearStorage();
    useTerminalUiStateStore.setState({
      terminalUiStateByThreadKey: {},
      suppressedTerminalIdsByThreadKey: {},
    });
  });

  it("returns an empty default terminal UI state for unknown threads", () => {
    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState).toEqual({
      terminalOpen: false,
      terminalHeight: 280,
      terminalIds: [],
      activeTerminalId: "",
      terminalGroups: [],
      activeTerminalGroupId: "",
    });
  });

  describe("drawer view", () => {
    const current = () =>
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      );

    it("opens the usage view without starting a shell, and the terminal view starts one", () => {
      const store = useTerminalUiStateStore.getState();
      store.setDrawerView(THREAD_REF, "usage", true);
      expect(current()).toMatchObject({ terminalOpen: true, drawerView: "usage", terminalIds: [] });

      // Closing and reopening keeps the thread's choice.
      store.setTerminalOpen(THREAD_REF, false);
      store.setTerminalOpen(THREAD_REF, true);
      expect(current()).toMatchObject({ terminalOpen: true, drawerView: "usage", terminalIds: [] });

      store.setDrawerView(THREAD_REF, "terminal");
      expect(current().drawerView).toBeUndefined();
      expect(current().terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID]);
    });

    it("keeps running terminals and their layout across a switch to usage and back", () => {
      const store = useTerminalUiStateStore.getState();
      store.setTerminalOpen(THREAD_REF, true);
      store.splitTerminal(THREAD_REF, "terminal-2");
      const before = current();

      store.setDrawerView(THREAD_REF, "usage");
      expect(current()).toMatchObject({
        drawerView: "usage",
        terminalOpen: true,
        terminalIds: before.terminalIds,
        terminalGroups: before.terminalGroups,
        activeTerminalId: "terminal-2",
      });

      store.setDrawerView(THREAD_REF, "terminal");
      expect(current()).toEqual(before);
    });

    it("stays on usage when a background shell exits, and a new shell brings the terminals back", () => {
      const store = useTerminalUiStateStore.getState();
      store.setTerminalOpen(THREAD_REF, true);
      store.setDrawerView(THREAD_REF, "usage");
      store.closeTerminal(THREAD_REF, DEFAULT_THREAD_TERMINAL_ID);
      expect(current()).toMatchObject({ terminalOpen: true, drawerView: "usage", terminalIds: [] });

      store.newTerminal(THREAD_REF, "terminal-2");
      expect(current().drawerView).toBeUndefined();
      expect(current().terminalIds).toEqual(["terminal-2"]);
    });

    it("is remembered per thread", () => {
      const store = useTerminalUiStateStore.getState();
      store.setDrawerView(THREAD_REF, "usage", true);
      store.setTerminalOpen(OTHER_THREAD_REF, true);
      expect(current().drawerView).toBe("usage");
      expect(
        selectThreadTerminalUiState(
          useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
          OTHER_THREAD_REF,
        ).drawerView,
      ).toBeUndefined();
    });

    it("opens usage at least at the minimum height and leaves the terminal height alone", () => {
      const store = useTerminalUiStateStore.getState();
      store.setTerminalOpen(THREAD_REF, true);
      expect(drawerHeightOf(current())).toBe(DEFAULT_THREAD_TERMINAL_HEIGHT);

      store.setDrawerView(THREAD_REF, "usage");
      expect(drawerHeightOf(current())).toBe(USAGE_DRAWER_MIN_HEIGHT);

      store.setDrawerView(THREAD_REF, "terminal");
      expect(drawerHeightOf(current())).toBe(DEFAULT_THREAD_TERMINAL_HEIGHT);
      expect(current().usageHeight).toBeUndefined();
    });

    it("keeps a taller terminal or usage height, and resizing usage keeps the terminals' height", () => {
      const store = useTerminalUiStateStore.getState();
      store.setTerminalOpen(THREAD_REF, true);
      store.setTerminalHeight(THREAD_REF, 600);
      store.setDrawerView(THREAD_REF, "usage");
      expect(drawerHeightOf(current())).toBe(600);

      store.setUsageHeight(THREAD_REF, 700);
      expect(current().terminalHeight).toBe(600);
      store.setDrawerView(THREAD_REF, "terminal");
      expect(drawerHeightOf(current())).toBe(600);
      store.setDrawerView(THREAD_REF, "usage");
      expect(drawerHeightOf(current())).toBe(700);
    });

    it("honours a shorter usage resize until the usage view is opened again", () => {
      const store = useTerminalUiStateStore.getState();
      store.setDrawerView(THREAD_REF, "usage", true);
      store.setUsageHeight(THREAD_REF, 250);
      // Choosing usage while it is already shown is not a new opening.
      store.setDrawerView(THREAD_REF, "usage", true);
      expect(drawerHeightOf(current())).toBe(250);

      store.setTerminalOpen(THREAD_REF, false);
      store.setTerminalOpen(THREAD_REF, true);
      expect(drawerHeightOf(current())).toBe(USAGE_DRAWER_MIN_HEIGHT);

      store.setUsageHeight(THREAD_REF, 250);
      store.setDrawerView(THREAD_REF, "terminal");
      store.setDrawerView(THREAD_REF, "usage");
      expect(drawerHeightOf(current())).toBe(USAGE_DRAWER_MIN_HEIGHT);
    });
  });

  it("opens and splits terminals into the active group", () => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.splitTerminal(THREAD_REF, "terminal-2");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalOpen).toBe(true);
    expect(terminalUiState.terminalIds).toEqual([DEFAULT_THREAD_TERMINAL_ID, "terminal-2"]);
    expect(terminalUiState.activeTerminalId).toBe("terminal-2");
    expect(terminalUiState.terminalGroups).toEqual([
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "terminal-2"],
      },
    ]);
  });

  it("stacks vertically split terminals in the active group", () => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.splitTerminalVertical(THREAD_REF, "terminal-2");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalGroups).toEqual([
      {
        id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID, "terminal-2"],
        splitDirection: "vertical",
      },
    ]);
  });

  it("materializes the default terminal when opening an empty drawer", () => {
    useTerminalUiStateStore.getState().setTerminalOpen(THREAD_REF, true);

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState).toEqual({
      terminalOpen: true,
      terminalHeight: 280,
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
      terminalGroups: [
        {
          id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
          terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
        },
      ],
      activeTerminalGroupId: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
    });
  });

  it("caps splits at four terminals per group", () => {
    const store = useTerminalUiStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.splitTerminal(THREAD_REF, "terminal-4");
    store.splitTerminal(THREAD_REF, "terminal-5");
    store.splitTerminal(THREAD_REF, "terminal-6");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual([
      "terminal-2",
      "terminal-3",
      "terminal-4",
      "terminal-5",
    ]);
    expect(terminalUiState.terminalGroups).toEqual([
      {
        id: "group-terminal-2",
        terminalIds: ["terminal-2", "terminal-3", "terminal-4", "terminal-5"],
      },
    ]);
  });

  it("creates new terminals in a separate group", () => {
    useTerminalUiStateStore.getState().newTerminal(THREAD_REF, "terminal-2");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual(["terminal-2"]);
    expect(terminalUiState.activeTerminalId).toBe("terminal-2");
    expect(terminalUiState.activeTerminalGroupId).toBe("group-terminal-2");
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("ensures unknown server terminals are registered, opened, and activated", () => {
    const store = useTerminalUiStateStore.getState();
    store.ensureTerminal(THREAD_REF, "setup-setup", { open: true, active: true });

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalOpen).toBe(true);
    expect(terminalUiState.terminalIds).toEqual(["setup-setup"]);
    expect(terminalUiState.activeTerminalId).toBe("setup-setup");
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-setup-setup", terminalIds: ["setup-setup"] },
    ]);
  });

  it("keeps state isolated per environment when raw thread ids collide", () => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.newTerminal(OTHER_THREAD_REF, "env-b-terminal");

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalOpen,
    ).toBe(true);
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        OTHER_THREAD_REF,
      ).terminalIds,
    ).toEqual(["env-b-terminal"]);
  });

  it("drops persisted entries whose thread keys are not valid scoped keys", () => {
    const migrated = migratePersistedTerminalUiStateStoreState(
      {
        terminalStateByThreadKey: {
          [scopedThreadKey(THREAD_REF)]: {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["term-1"],
            activeTerminalId: "term-1",
            terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
            activeTerminalGroupId: "group-term-1",
          },
          "legacy-thread-id": {
            terminalOpen: true,
            terminalHeight: 320,
            terminalIds: ["term-1"],
            activeTerminalId: "term-1",
            terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
            activeTerminalGroupId: "group-term-1",
          },
        },
      },
      2,
    );

    expect(migrated).toEqual({
      terminalUiStateByThreadKey: {
        [scopedThreadKey(THREAD_REF)]: {
          terminalOpen: true,
          terminalHeight: 320,
          terminalIds: ["term-1"],
          activeTerminalId: "term-1",
          terminalGroups: [{ id: "group-term-1", terminalIds: ["term-1"] }],
          activeTerminalGroupId: "group-term-1",
        },
      },
    });
  });

  it("resets to default and clears persisted entry when closing the last terminal", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "terminal-only");
    store.closeTerminal(THREAD_REF, "terminal-only");

    expect(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey[scopedThreadKey(THREAD_REF)],
    ).toBeUndefined();
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual([]);
  });

  it("keeps a valid active terminal after closing an active split terminal", () => {
    const store = useTerminalUiStateStore.getState();
    store.splitTerminal(THREAD_REF, "terminal-2");
    store.splitTerminal(THREAD_REF, "terminal-3");
    store.closeTerminal(THREAD_REF, "terminal-3");

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.activeTerminalId).toBe("terminal-2");
    expect(terminalUiState.terminalIds).toEqual(["terminal-2"]);
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-terminal-2", terminalIds: ["terminal-2"] },
    ]);
  });

  it("reconciles terminal ids from an external ordered list", () => {
    const store = useTerminalUiStateStore.getState();
    store.setTerminalOpen(THREAD_REF, true);
    store.reconcileTerminalIds(THREAD_REF, ["term-a", "term-b"]);

    const terminalUiState = selectThreadTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
      THREAD_REF,
    );
    expect(terminalUiState.terminalIds).toEqual(["term-a", "term-b"]);
    expect(terminalUiState.activeTerminalId).toBe("term-a");
    expect(terminalUiState.terminalGroups).toEqual([
      { id: "group-term-a", terminalIds: ["term-a"] },
      { id: "group-term-b", terminalIds: ["term-b"] },
    ]);
  });

  it("does not import a closed panel terminal from stale metadata", () => {
    const store = useTerminalUiStateStore.getState();
    store.newTerminal(THREAD_REF, "term-2");
    store.closeTerminal(THREAD_REF, "term-1");

    store.reconcileTerminalIds(THREAD_REF, ["term-1", "term-2"]);

    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["term-2"]);

    store.newTerminal(THREAD_REF, "term-1");
    expect(
      selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        THREAD_REF,
      ).terminalIds,
    ).toEqual(["term-2", "term-1"]);
  });

  it("is a no-op when clearing terminal UI state for a thread with no state", () => {
    const store = useTerminalUiStateStore.getState();
    const before = useTerminalUiStateStore.getState();

    store.clearTerminalUiState(THREAD_REF);

    expect(useTerminalUiStateStore.getState()).toBe(before);
  });
});
