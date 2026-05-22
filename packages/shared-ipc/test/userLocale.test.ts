import { describe, expect, it } from "vitest";
import {
  buildLanguageSystemPrompt,
  detectUserLocale,
  resolveSessionUserLocale
} from "../src/userLocale";

describe("detectUserLocale", () => {
  it("returns en for English-only text", () => {
    expect(detectUserLocale("create a clock widget")).toBe("en");
    expect(detectUserLocale("hello")).toBe("en");
  });

  it("detects Simplified Chinese", () => {
    expect(detectUserLocale("我将提供素材")).toBe("zh-Hans");
    expect(detectUserLocale("给我点儿惊喜")).toBe("zh-Hans");
  });

  it("detects Traditional Chinese", () => {
    expect(detectUserLocale("我將提供素材")).toBe("zh-Hant");
    expect(detectUserLocale("之後會給圖")).toBe("zh-Hant");
  });
});

describe("resolveSessionUserLocale", () => {
  it("sticks to persisted Chinese when latest message is short English", () => {
    expect(resolveSessionUserLocale("zh-Hans", "ok")).toBe("zh-Hans");
  });

  it("updates when user switches to Traditional in latest message", () => {
    expect(resolveSessionUserLocale("zh-Hans", "我將提供素材")).toBe("zh-Hant");
  });

  it("uses detected locale when no persistence", () => {
    expect(resolveSessionUserLocale(null, "做个游戏")).toBe("zh-Hans");
  });
});

describe("buildLanguageSystemPrompt", () => {
  it("includes session locale line for zh-Hans", () => {
    const prompt = buildLanguageSystemPrompt("zh-Hans");
    expect(prompt).toContain("Session locale");
    expect(prompt).toContain("zh-Hans");
    expect(prompt).toContain("Must");
  });
});
