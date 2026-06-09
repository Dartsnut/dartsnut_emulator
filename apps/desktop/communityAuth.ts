import fs from "node:fs";
import path from "node:path";

export type PersistedCommunityAuth = {
  token: string;
  account: string;
};

export function communityAuthPath(userDataPath: string): string {
  return path.join(userDataPath, "community-auth.json");
}

export function readCommunityAuth(userDataPath: string): PersistedCommunityAuth | null {
  const file = communityAuthPath(userDataPath);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<PersistedCommunityAuth>;
    const token = String(parsed.token || "").trim();
    const account = String(parsed.account || "").trim();
    if (!token) {
      return null;
    }
    return { token, account };
  } catch {
    return null;
  }
}

export function writeCommunityAuth(userDataPath: string, auth: PersistedCommunityAuth): void {
  const file = communityAuthPath(userDataPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ token: auth.token.trim(), account: auth.account.trim() }, null, 2)
  );
}

export function clearCommunityAuth(userDataPath: string): void {
  const file = communityAuthPath(userDataPath);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}
