import { describe, expect, it } from "vitest";
import {
  createHiddenVenvPrepDisplay,
  createVenvPrepStatus,
  nextVenvPrepDisplay,
  VENV_PREP_STATUS_HOLD_MS,
} from "../src";

describe("venv prep status helpers", () => {
  it("creates the status snapshot the desktop emits before a reload starts", () => {
    expect(createVenvPrepStatus()).toBe("venv:Preparing workspace environment…");
  });

  it("keeps a briefly-cleared game venv status visible long enough to paint", () => {
    const preparing = nextVenvPrepDisplay(
      createHiddenVenvPrepDisplay(),
      "venv:Syncing dependencies...",
      1000,
    );

    const clearedQuickly = nextVenvPrepDisplay(preparing, "", 1001);

    expect(clearedQuickly.visible).toBe(true);
    expect(clearedQuickly.message).toBe("Syncing dependencies...");
  });

  it("hides the prep hint after the hold window expires", () => {
    const preparing = nextVenvPrepDisplay(
      createHiddenVenvPrepDisplay(),
      "venv:Preparing workspace environment...",
      1000,
    );

    const expired = nextVenvPrepDisplay(preparing, "", 1000 + VENV_PREP_STATUS_HOLD_MS);

    expect(expired.visible).toBe(false);
  });
});
