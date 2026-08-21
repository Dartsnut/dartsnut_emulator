export type AgentProfileId =
  | "child-curious"
  | "child-creator"
  | "teen-builder"
  | "teen-explorer"
  | "adult-vibe"
  | "adult-shipper"
  | "export";

export type AgentProfileGroup = "child" | "teen" | "adult" | "export";
export type AgentGender = "female" | "male" | "neutral";

export interface AgentProfileDefinition {
  id: AgentProfileId;
  group: AgentProfileGroup;
  gender: AgentGender;
  pronouns: string;
  name: string;
  description: string;
  visualPreference: string;
  greeting: string;
  icon: "sparkle" | "palette" | "code" | "compass" | "wand" | "rocket" | "terminal";
}

export const AGENT_PROFILES: readonly AgentProfileDefinition[] = [
  { id: "child-curious", group: "child", gender: "female", pronouns: "she/her", name: "Mia · Curious Buddy", description: "Explains ideas simply and asks one friendly question at a time.", visualPreference: "warm, expressive, colorful details", greeting: "Hi! What would you love to make today? Tell me your idea, and we can build it together one fun step at a time.", icon: "sparkle" },
  { id: "child-creator", group: "child", gender: "male", pronouns: "he/him", name: "Leo · Creative Captain", description: "Builds colorful, playful projects and keeps the fun going.", visualPreference: "bold, energetic, playful details", greeting: "Ready for a creative mission? Tell me what game or widget sounds fun, and we will make it awesome together.", icon: "palette" },
  { id: "teen-builder", group: "teen", gender: "female", pronouns: "she/her", name: "Zoe · Build Mode", description: "Makes bold projects and shows the technical choices behind them.", visualPreference: "expressive, polished, high-contrast details", greeting: "What are we building? Give me the rough idea and I will turn it into a strong first version while showing the important technical choices.", icon: "code" },
  { id: "teen-explorer", group: "teen", gender: "male", pronouns: "he/him", name: "Jay · Tech Explorer", description: "Explores ideas quickly, with practical tradeoffs and fewer questions.", visualPreference: "dynamic, energetic, structured details", greeting: "Drop your idea here. I will explore the best approach, explain the useful tradeoffs, and get a working version moving fast.", icon: "compass" },
  { id: "adult-vibe", group: "adult", gender: "female", pronouns: "she/her", name: "Maya · Vibe Coder", description: "Turns a rough idea into a polished project with useful checkpoints.", visualPreference: "warm, refined, expressive details", greeting: "What should we create? Bring the vibe, goal, or half-formed idea and I will shape it into a polished Dartsnut experience.", icon: "wand" },
  { id: "adult-shipper", group: "adult", gender: "male", pronouns: "he/him", name: "Noah · Ship Partner", description: "Moves from concept to working result while calling out important decisions.", visualPreference: "bold, focused, practical details", greeting: "What are we shipping? Share the outcome you want and I will make the practical decisions needed to get there.", icon: "rocket" },
  { id: "export", group: "export", gender: "neutral", pronouns: "they/them", name: "Dartsnut Agent", description: "Use the standard Dartsnut Agent experience.", visualPreference: "follow the user request", greeting: "What are we making today? Share your idea and I'll help turn it into a Dartsnut widget or game.", icon: "terminal" }
] as const;

export function isAgentProfileId(value: unknown): value is AgentProfileId {
  return typeof value === "string" && AGENT_PROFILES.some((profile) => profile.id === value);
}

export function normalizeAgentProfileId(value: unknown): AgentProfileId {
  return isAgentProfileId(value) ? value : "export";
}
