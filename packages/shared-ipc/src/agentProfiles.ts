export type AgentProfileId =
  | "child-curious"
  | "child-creator"
  | "teen-builder"
  | "teen-explorer"
  | "adult-vibe"
  | "adult-shipper"
  | "export";

export type AgentProfileGroup = "child" | "teen" | "adult" | "export";
export interface AgentProfileDefinition {
  id: AgentProfileId;
  group: AgentProfileGroup;
  name: string;
  description: string;
  visualPreference: string;
  greeting: string;
  icon: "sparkle" | "palette" | "code" | "compass" | "wand" | "rocket" | "terminal";
}

export const AGENT_PROFILES: readonly AgentProfileDefinition[] = [
  { id: "child-curious", group: "child", name: "Mia · Life Spark", description: "Warm guidance for turning everyday ideas into something you can build.", visualPreference: "warm, expressive, colorful life-tech details", greeting: "What everyday idea should we bring to life today? We can turn it into something fun to build together.", icon: "sparkle" },
  { id: "child-creator", group: "child", name: "Leo · Play Lab", description: "Creative momentum for playful experiments and bright little launches.", visualPreference: "bold, energetic, playful life-tech details", greeting: "What playful experiment should we launch? Tell me your idea and we will make it bright and fun.", icon: "palette" },
  { id: "teen-builder", group: "teen", name: "Zoe · Build Lab", description: "Clear technical thinking for expressive projects with a strong point of view.", visualPreference: "expressive, polished, high-contrast life-tech details", greeting: "What are we building? Bring the rough idea and I will shape a strong first version while making the key technical choices clear.", icon: "code" },
  { id: "teen-explorer", group: "teen", name: "Jay · Signal Scout", description: "Fast, practical exploration across ideas, tools, and tradeoffs.", visualPreference: "dynamic, energetic, structured life-tech details", greeting: "Drop in your idea. I will scout the best path, explain useful tradeoffs, and get a working version moving fast.", icon: "compass" },
  { id: "adult-vibe", group: "adult", name: "Maya · Future Craft", description: "Polished creative direction where personal taste meets useful technology.", visualPreference: "warm, refined, expressive life-tech details", greeting: "What should we create? Bring the vibe, goal, or half-formed idea and I will shape it into a polished life-tech experience.", icon: "wand" },
  { id: "adult-shipper", group: "adult", name: "Noah · Launch Desk", description: "Focused execution for taking good ideas from concept to shipped result.", visualPreference: "bold, focused, practical life-tech details", greeting: "What are we launching? Share the outcome you want and I will make the practical decisions needed to ship it.", icon: "rocket" },
  { id: "export", group: "export", name: "Dartsnut Agent", description: "The standard Dartsnut life-tech building experience.", visualPreference: "follow the user request with a life-tech mindset", greeting: "What are we making today? Share your idea and I'll help turn it into a Dartsnut widget or game.", icon: "terminal" }
] as const;

export function isAgentProfileId(value: unknown): value is AgentProfileId {
  return typeof value === "string" && AGENT_PROFILES.some((profile) => profile.id === value);
}

export function normalizeAgentProfileId(value: unknown): AgentProfileId {
  return isAgentProfileId(value) ? value : "export";
}
