import { describe, expect, it } from "vitest";
import {
  hasSubstantiveCreatorUserRequest,
  mainPyLooksLikePhase2Stub,
  shouldInjectCreatorIncompleteNudge,
  shouldInjectCreatorStallNudge
} from "../src/creatorTurnGuard";
import type { ChatMessage } from "../src/providerClient";

const PVRV9G_PHASE2_STUB = `from PIL import Image

def main():
    frame = Image.new("RGB", (128, 128), (0, 0, 0))
`;

const FULL_CLOCK_MAIN = `from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

def draw_clock(frame):
    draw = ImageDraw.Draw(frame)
    draw.text((10, 10), "12:00", fill=(255, 255, 255))

def main():
    frame = Image.new("RGB", (128, 128), (0, 0, 0))
    font = ImageFont.truetype(str(Path(__file__).parent / "fonts" / "big_digits.pil"), 16)
    draw_clock(frame)
`;

describe("shouldInjectCreatorIncompleteNudge", () => {
  it("returns true for widget-creator with substantive prompt and missing artifacts", () => {
    expect(
      shouldInjectCreatorIncompleteNudge({
        templateMode: "widget-creator",
        artifacts: { confJson: false, mainPy: false },
        filesWrittenThisTurn: 0,
        initialPrompt: ["TEMPLATE", "", "User request:", "Trajectory smoothing"].join("\n"),
        messages: [],
        systemSlots: 0,
        nudgeCount: 0
      })
    ).toBe(true);
  });

  it("returns false when conf.json and main.py exist", () => {
    expect(
      shouldInjectCreatorIncompleteNudge({
        templateMode: "widget-creator",
        artifacts: { confJson: true, mainPy: true },
        filesWrittenThisTurn: 0,
        initialPrompt: "Trajectory smoothing",
        messages: [],
        systemSlots: 0,
        nudgeCount: 0
      })
    ).toBe(false);
  });

  it("returns false after max nudges", () => {
    expect(
      shouldInjectCreatorIncompleteNudge({
        templateMode: "widget-creator",
        artifacts: { confJson: false, mainPy: false },
        filesWrittenThisTurn: 0,
        initialPrompt: "Trajectory smoothing",
        messages: [],
        systemSlots: 0,
        nudgeCount: 4
      })
    ).toBe(false);
  });
});

describe("hasSubstantiveCreatorUserRequest", () => {
  it("detects routed follow-up user lines", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: ["TEMPLATE", "", "User request:", "Trajectory smoothing"].join("\n") }
    ];
    expect(hasSubstantiveCreatorUserRequest("", messages, 0)).toBe(true);
  });
});

describe("mainPyLooksLikePhase2Stub", () => {
  it("returns true for PVRV9g-style blank frame stub", () => {
    expect(mainPyLooksLikePhase2Stub(PVRV9G_PHASE2_STUB)).toBe(true);
  });

  it("returns true for the real PVRV9g session main.py body", () => {
    const pvrMain = `import time
from PIL import Image
from pydartsnut import Dartsnut

def main():
    dartsnut = Dartsnut()
    w, h = 128, 128
    while dartsnut.running:
        frame = Image.new("RGB", (w, h), (0, 0, 0))
        dartsnut.update_frame_buffer(frame)
        time.sleep(0.05)

if __name__ == "__main__":
    main()
`;
    expect(mainPyLooksLikePhase2Stub(pvrMain)).toBe(true);
  });

  it("returns false when main.py has real widget logic", () => {
    expect(mainPyLooksLikePhase2Stub(FULL_CLOCK_MAIN)).toBe(false);
  });
});

describe("shouldInjectCreatorStallNudge", () => {
  const substantivePrompt = ["TEMPLATE", "", "User request:", "128x128 flipping clock"].join("\n");

  it("returns true when scaffold exists, no tools, and reasoning is huge", () => {
    expect(
      shouldInjectCreatorStallNudge({
        templateMode: "widget-creator",
        artifacts: { confJson: true, mainPy: true },
        filesWrittenThisTurn: 0,
        toolCallCount: 0,
        reasoningChars: 41089,
        reasoningContent: "```python\n" + "x".repeat(5000),
        mainPyContent: PVRV9G_PHASE2_STUB,
        initialPrompt: substantivePrompt,
        messages: [],
        systemSlots: 0,
        nudgeCount: 0
      })
    ).toBe(true);
  });

  it("returns false for incomplete nudge scenario (missing files)", () => {
    expect(
      shouldInjectCreatorIncompleteNudge({
        templateMode: "widget-creator",
        artifacts: { confJson: true, mainPy: true },
        filesWrittenThisTurn: 0,
        initialPrompt: substantivePrompt,
        messages: [],
        systemSlots: 0,
        nudgeCount: 0
      })
    ).toBe(false);
  });

  it("returns false when main.py already has implementation", () => {
    expect(
      shouldInjectCreatorStallNudge({
        templateMode: "widget-creator",
        artifacts: { confJson: true, mainPy: true },
        filesWrittenThisTurn: 0,
        toolCallCount: 0,
        reasoningChars: 5000,
        reasoningContent: "```python\nclock\n```",
        mainPyContent: FULL_CLOCK_MAIN,
        initialPrompt: substantivePrompt,
        messages: [],
        systemSlots: 0,
        nudgeCount: 0
      })
    ).toBe(false);
  });
});
