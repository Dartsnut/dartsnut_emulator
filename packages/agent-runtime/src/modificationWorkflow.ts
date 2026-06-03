export interface ModificationRunOptions {
  userPrompt: string;
}

const SURGICAL_MODIFICATION_PREAMBLE = [
  "Modification workflow (surgical — load **karpathy-guidelines** via `get_dartsnut_skill` before edits):",
  "- Touch only what this request requires; every changed line must trace to the user goal.",
  "- Prefer **replace_in_file** over **write_file** for existing files; do not re-scaffold or rewrite whole files unless unavoidable.",
  "- **read_file** before edits; after material changes run **reload_emulator** then **get_emulator_logs**.",
  "- No speculative refactors, no drive-by cleanup, no new features beyond the request.",
  "- One pass only: apply the smallest fix set, then reply with one short status sentence and stop.",
  "- After **reload_emulator** + **get_emulator_logs**, if logs have no Traceback/SyntaxError/ModuleNotFoundError, **stop immediately** — do not keep editing."
].join("\n");

export function buildModificationWorkflowPrompt(options: ModificationRunOptions): string {
  const userPrompt = options.userPrompt.trim();
  return [SURGICAL_MODIFICATION_PREAMBLE, "", "User request:", userPrompt].join("\n");
}
