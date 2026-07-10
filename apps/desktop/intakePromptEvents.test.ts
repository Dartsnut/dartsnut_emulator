const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildIntakeProjectTypePromptEvent,
  buildIntakeWidgetSizePromptEvent
} = require("./intakePromptEvents.ts");

test("buildIntakeProjectTypePromptEvent includes locale on visible events", () => {
  assert.deepEqual(buildIntakeProjectTypePromptEvent(true, "zh-Hans"), {
    type: "intake_project_type_prompt",
    at: 0,
    visible: true,
    options: ["game", "widget"],
    locale: "zh-Hans"
  });
});

test("buildIntakeProjectTypePromptEvent omits locale on hide events", () => {
  assert.deepEqual(buildIntakeProjectTypePromptEvent(false, "zh-Hans"), {
    type: "intake_project_type_prompt",
    at: 0,
    visible: false
  });
});

test("buildIntakeWidgetSizePromptEvent includes locale on visible events", () => {
  assert.deepEqual(buildIntakeWidgetSizePromptEvent(true, ["128x160", "128x128"], "zh-Hant"), {
    type: "intake_widget_size_prompt",
    at: 0,
    visible: true,
    sizes: ["128x160", "128x128"],
    locale: "zh-Hant"
  });
});

test("buildIntakeWidgetSizePromptEvent omits locale on hide events", () => {
  assert.deepEqual(buildIntakeWidgetSizePromptEvent(false, ["128x160"], "zh-Hant"), {
    type: "intake_widget_size_prompt",
    at: 0,
    visible: false
  });
});
