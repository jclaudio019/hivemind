import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import type { Credentials } from "../commands/auth-creds.js";
import { join } from "node:path";

export const LOCAL_ROOT = join(homedir(), ".local-hivemind");
const ENABLED_MARKER = join(LOCAL_ROOT, "enabled");

export function isLocalMode(): boolean {
  return process.env.HIVEMIND_BACKEND === "local" || existsSync(ENABLED_MARKER);
}

export function localSessionCredentials(): Credentials | null {
  if (!isLocalMode()) return null;
  return {
    token: "local", orgId: "local", orgName: "local",
    userName: process.env.HIVEMIND_USER_NAME || userInfo().username || "local",
    workspaceId: process.env.HIVEMIND_WORKSPACE_ID ?? "default", apiUrl: "local",
    savedAt: new Date().toISOString(), autoupdate: false,
  };
}

export function enableLocalMode(): void {
  mkdirSync(LOCAL_ROOT, { recursive: true, mode: 0o700 });
  writeFileSync(ENABLED_MARKER, "local\n", { mode: 0o600 });
}

export function disableLocalMode(): void {
  try { unlinkSync(ENABLED_MARKER); } catch { /* already disabled */ }
}

export function localModeStatus(): boolean {
  return isLocalMode();
}
