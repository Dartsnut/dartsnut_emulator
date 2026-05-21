export function isCreatorTemplateMode(mode: string | null | undefined): boolean {
  return mode === "game-creator" || mode === "widget-creator";
}

export function isFileMutationToolName(name: string): boolean {
  return name === "write_file" || name === "replace_in_file" || name === "copy_asset_file";
}

export function readCreatorArtifactStatus(
  existsSync: (absolutePath: string) => boolean,
  resolveWithinRoot: (relativePath: string) => string
): { confJson: boolean; mainPy: boolean } {
  try {
    return {
      confJson: existsSync(resolveWithinRoot("conf.json")),
      mainPy: existsSync(resolveWithinRoot("main.py"))
    };
  } catch {
    return { confJson: false, mainPy: false };
  }
}
