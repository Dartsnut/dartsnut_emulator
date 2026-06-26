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

  it("sticks to persisted Chinese when latest message is a short Chinese follow-up", () => {
    expect(resolveSessionUserLocale("zh-Hant", "好")).toBe("zh-Hant");
    expect(resolveSessionUserLocale("zh-Hans", "继续")).toBe("zh-Hans");
  });

  it("switches to English when latest message is clearly English", () => {
    expect(resolveSessionUserLocale("zh-Hans", "please make the game faster")).toBe("en");
    expect(resolveSessionUserLocale("zh-Hant", "create a clock widget")).toBe("en");
  });

  it("updates when user switches to Traditional in latest message", () => {
    expect(resolveSessionUserLocale("zh-Hans", "我將提供素材")).toBe("zh-Hant");
  });

  it("updates when user switches to Simplified in latest message", () => {
    expect(resolveSessionUserLocale("zh-Hant", "我将提供素材")).toBe("zh-Hans");
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

  it("states that response language is output-only and must not affect behavior", () => {
    const prompt = buildLanguageSystemPrompt("zh-Hant");
    expect(prompt).toContain("output-only");
    expect(prompt).toContain("must not change behavior");
    expect(prompt).toContain("routing");
    expect(prompt).toContain("tool choice");
    expect(prompt).toContain("intake");
  });
});
