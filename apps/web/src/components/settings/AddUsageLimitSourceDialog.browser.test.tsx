import { EnvironmentId } from "@t3tools/contracts";
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

// Base UI keeps a closed popup mounted until its exit finishes, so check what is painted.
const listShown = () =>
  document.querySelector<HTMLElement>('[data-slot="select-popup"]')?.checkVisibility() ?? false;

describe("AddUsageLimitSourceDialog", () => {
  it("closes the source list after a source is picked with the mouse or the keyboard", async () => {
    await page.viewport(1280, 800);
    await act(() =>
      root.render(
        <StrictMode>
          <AppAtomRegistryProvider>
            <AddUsageLimitSourceDialog
              open
              onOpenChange={() => undefined}
              environmentId={EnvironmentId.make("env-test")}
              environmentLabel="This device"
              existingIds={new Set()}
            />
          </AppAtomRegistryProvider>
        </StrictMode>,
      ),
    );
    const trigger = page.getByRole("combobox", { name: "Usage source" });

    for (const name of ["fal", "Higgsfield", "TypeSafe (Jev)"]) {
      await act(async () => userEvent.click(trigger));
      await expect.element(page.getByRole("option", { name })).toBeVisible();
      await act(async () => userEvent.click(page.getByRole("option", { name })));
      await vi.waitFor(() => expect(listShown()).toBe(false));
      await expect.element(trigger).toHaveTextContent(name);
    }

    await act(async () => userEvent.click(trigger));
    await expect.element(page.getByRole("option", { name: "DeepSeek" })).toBeVisible();
    await act(async () => userEvent.keyboard("{ArrowDown}{Enter}"));
    await vi.waitFor(() => expect(listShown()).toBe(false));
  });
});
