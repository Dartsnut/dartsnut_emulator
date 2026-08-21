import { describe, expect, it } from "vitest";
import { AGENT_PROFILES, isAgentProfileId, normalizeAgentProfileId } from "../src/agentProfiles";

describe("agent profiles", () => {
  it("contains six persona variants plus Export", () => {
    expect(AGENT_PROFILES).toHaveLength(7);
    expect(new Set(AGENT_PROFILES.map((profile) => profile.id)).size).toBe(7);
  });

  it("validates IDs and falls back safely", () => {
    expect(isAgentProfileId("child-curious")).toBe(true);
    expect(isAgentProfileId("missing")).toBe(false);
    expect(normalizeAgentProfileId("missing")).toBe("export");
  });

  it("uses life-tech branding without gender metadata", () => {
    expect(AGENT_PROFILES.map((profile) => profile.name)).toEqual([
      "Mia · Life Spark",
      "Leo · Play Lab",
      "Zoe · Build Lab",
      "Jay · Signal Scout",
      "Maya · Future Craft",
      "Noah · Launch Desk",
      "Dartsnut Agent"
    ]);
    for (const profile of AGENT_PROFILES) {
      expect(profile).not.toHaveProperty("gender");
      expect(profile).not.toHaveProperty("pronouns");
    }
  });
});
