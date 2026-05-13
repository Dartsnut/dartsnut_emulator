export type BuildSyncWorkspaceScriptOptions = {
  appId: string;
  password: string;
  remoteUploadTgz: string;
};

export function buildSyncWorkspaceScript({
  appId,
  password,
  remoteUploadTgz,
}: BuildSyncWorkspaceScriptOptions): string {
  const escapedAppId = appId.replace(/'/g, "'\\''");
  return [
    "set -eo pipefail",
    "PASS=" + JSON.stringify(password),
    "TGZ=" + remoteUploadTgz,
    "APPID='" + escapedAppId + "'",
    'BASE="$HOME/dartsnut_rpi/apps"',
    'TARGET="$BASE/$APPID"',
    'STAGING="${TARGET}.new.${RANDOM}"',
    'echo "$PASS" | sudo -S rm -rf "$STAGING"',
    'echo "$PASS" | sudo -S mkdir -p "$BASE"',
    'echo "$PASS" | sudo -S mkdir -p "$STAGING"',
    'echo "$PASS" | sudo -S tar -xzf "$TGZ" -C "$STAGING"',
    'echo "$PASS" | sudo -S rm -rf "$TARGET"',
    'echo "$PASS" | sudo -S mv "$STAGING" "$TARGET"',
    'rm -f "$TGZ"',
  ].join("\n");
}
