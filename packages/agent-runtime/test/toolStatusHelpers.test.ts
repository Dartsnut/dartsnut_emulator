import { describe, expect, it } from "vitest";
import { emitToolStatusEvent } from "../src/toolStatusHelpers";

describe("toolStatusHelpers", () => {
  it("persists Dartsnut skill status rows with skill id metadata", () => {
    const events: unknown[] = [];
    const persisted: unknown[] = [];

    emitToolStatusEvent(
      "get_dartsnut_skill",
      "result",
      (event) => events.push(event),
      { callId: "c1", skillId: "conf-contract" },
      (kind, text) => persisted.push({ kind, text })
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "status",
      message: expect.stringContaining('"skillId":"conf-contract"')
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      kind: "tool_status",
      text: expect.stringContaining('"skillId":"conf-contract"')
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
});
