import { describe, expect, it } from "vitest";
import { buildCreationIntakeUserPrompt } from "../src/creationIntakePrompt";

describe("buildCreationIntakeUserPrompt", () => {
  it("includes the user request and intake procedure", () => {
    const prompt = buildCreationIntakeUserPrompt("我想要一个可爱的呼吸小组件");
    expect(prompt).toContain("我想要一个可爱的呼吸小组件");
    expect(prompt).toContain("dartsnut_ask_question");
    expect(prompt).toContain("widget_display_size");
    expect(prompt).toContain("build it now");
    expect(prompt).toContain("get_emulator_logs");
    expect(prompt).not.toContain("hand off");
    expect(prompt).not.toContain("will run next");
  });

  it("adds picker hints when size was chosen in the UI", () => {
    const prompt = buildCreationIntakeUserPrompt("hello", { widgetSizeFromPicker: "128x128" });
    expect(prompt).toContain("128x128");
    expect(prompt).toContain("[UI] User chose widget display size");
  });
});
