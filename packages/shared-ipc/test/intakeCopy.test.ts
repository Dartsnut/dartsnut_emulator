import { describe, expect, it } from "vitest";
import { getIntakeCopy } from "../src/intakeCopy";

describe("getIntakeCopy", () => {
  it("returns the existing English intake copy by default", () => {
    const copy = getIntakeCopy("en");

    expect(copy.projectTypeQuestion).toBe("Are you building a game or a widget?");
    expect(copy.projectTypeLabels).toEqual({ game: "Game", widget: "Widget" });
    expect(copy.widgetSizeQuestion).toBe("Which widget display size do you want?");
    expect(copy.card.title).toBe("Questions");
    expect(copy.card.groupAriaLabel).toBe("Question");
    expect(copy.card.continueLabel).toBe("Continue");
    expect(copy.card.answerChoicesAriaLabel).toBe("Answer choices");
    expect(copy.card.pagerLabel(1, 1)).toBe("Question 1 of 1");
    expect(copy.card.pagerText(1, 1)).toBe("1 of 1");
  });

  it("returns Simplified Chinese intake copy", () => {
    const copy = getIntakeCopy("zh-Hans");

    expect(copy.projectTypeQuestion).toBe("你要做游戏还是小组件？");
    expect(copy.projectTypeLabels).toEqual({ game: "游戏", widget: "小组件" });
    expect(copy.widgetSizeQuestion).toBe("你想要哪种小组件显示尺寸？");
    expect(copy.card.continueLabel).toBe("继续");
  });

  it("returns Traditional Chinese intake copy", () => {
    const copy = getIntakeCopy("zh-Hant");

    expect(copy.projectTypeQuestion).toBe("你要做遊戲還是小組件？");
    expect(copy.projectTypeLabels).toEqual({ game: "遊戲", widget: "小組件" });
    expect(copy.widgetSizeQuestion).toBe("你想要哪種小組件顯示尺寸？");
    expect(copy.card.continueLabel).toBe("繼續");
  });

  it("falls back to English for missing or unknown locale", () => {
    expect(getIntakeCopy(null).projectTypeQuestion).toBe("Are you building a game or a widget?");
    expect(getIntakeCopy("fr" as never).projectTypeLabels.widget).toBe("Widget");
  });
});
