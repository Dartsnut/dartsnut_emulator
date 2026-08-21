import { describe, expect, it } from "vitest";
import { buildToolStatusMessage, emitToolStatusEvent, extractPathFromArgumentsJson } from "../src/toolStatusHelpers";

describe("toolStatusHelpers", () => {
  it("persists Dartsnut skill status rows with skill id metadata", () => {
    const events: unknown[] = [];
    const persisted: unknown[] = [];

    emitToolStatusEvent(
      "get_dartsnut_skill",
      "result",
      (event) => events.push(event),
      { callId: "c1", skillId: "dartsnut-core" },
      (kind, text) => persisted.push({ kind, text })
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "status",
      message: expect.stringContaining('"skillId":"dartsnut-core"')
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      kind: "tool_status",
      text: expect.stringContaining('"skillId":"dartsnut-core"')
    });
  });

  it("still persists user-relevant tool status rows", () => {
    const persisted: unknown[] = [];

    emitToolStatusEvent(
      "write_file",
      "result",
      () => undefined,
      { callId: "c2", path: "main.py", added: 3, deleted: 0 },
      (kind, text) => persisted.push({ kind, text })
    );

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ kind: "tool_status" });
  });

  it("formats emulator observation and scenario tool statuses", () => {
    expect(buildToolStatusMessage("observe_emulator", "call").text).toBe("Observing display…");
    expect(buildToolStatusMessage("observe_emulator", "result").text).toBe("Observed display.");
    expect(buildToolStatusMessage("run_emulator_scenario", "call").text).toBe("Running emulator scenario…");
    expect(buildToolStatusMessage("run_emulator_scenario", "result").text).toBe("Ran emulator scenario.");
  });

  it("extracts the newest path from concatenated streamed argument objects", () => {
    const concat =
      "{\"content\":\"{}\",\"path\":\"conf.json\"}" +
      "{\"content\":\"print(\\\"ok\\\")\",\"path\":\"main.py\"}";

    expect(extractPathFromArgumentsJson(concat)).toBe("main.py");
  });

  it("does not reuse an older path when a newer concatenated object is still streaming", () => {
    const concat =
      "{\"content\":\"{}\",\"path\":\"conf.json\"}" +
      "{\"content\":\"import math";

    expect(extractPathFromArgumentsJson(concat)).toBeUndefined();
  });
});
