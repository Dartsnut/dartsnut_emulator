import path from "node:path";

export class WorkspacePolicy {
  constructor(private readonly workspaceRoot: string) {}

  getRoot(): string {
    return this.workspaceRoot;
  }

  resolveWithinRoot(relativePath: string): string {
    const resolved = path.resolve(this.workspaceRoot, relativePath);
    const normalizedRoot = path.resolve(this.workspaceRoot) + path.sep;
    if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(this.workspaceRoot)) {
      throw new Error("Path escapes workspace root.");
    }
    return resolved;
  }
}
