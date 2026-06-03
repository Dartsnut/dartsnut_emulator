import { describe, expect, it } from "vitest";
import {
  canRecordProjectTypeFromUserText,
  canRecordWidgetSizeFromUserText,
  inferProjectTypeFromUserText,
  isVagueCreationUserPrompt,
  parseExplicitWidgetSizeToken
} from "../src/creationIntakeInference";

describe("creationIntakeInference", () => {
  it("treats surprise me as vague", () => {
    expect(isVagueCreationUserPrompt("surprise me")).toBe(true);
    expect(inferProjectTypeFromUserText("surprise me")).toBeUndefined();
    expect(canRecordWidgetSizeFromUserText("surprise me", "128x128")).toBe(false);
  });

  it("infers widget from explicit widget wording", () => {
    expect(inferProjectTypeFromUserText("cute breathing widget")).toBe("widget");
    expect(canRecordProjectTypeFromUserText("cute breathing widget", "widget")).toBe(true);
  });

  it("parses explicit WxH tokens only", () => {
    expect(parseExplicitWidgetSizeToken("128x128")).toBe("128x128");
    expect(parseExplicitWidgetSizeToken("surprise me")).toBeUndefined();
    expect(canRecordWidgetSizeFromUserText("make a 128x128 widget", "128x128")).toBe(true);
  });
});
