/**
 * Uncached read of the org's prepaid balance.
 *
 * The balance rides on the `X-Activeloop-Balance-Cents` response header of the
 * SQL endpoint (`/workspaces/{workspace}/tables/query`) — NOT on
 * `/me/hivemind-stats`. Verified 2026-08-13 against api.deeplake.ai across ten
 * orgs: hivemind-stats never carries the header, the query endpoint always
 * does. `org-stats.ts` reads it off hivemind-stats, which is why its balance
 * has silently been null in production the whole time and the low-balance
 * warning never fired from that path.
 *
 * A bare `SELECT 1` is the cheapest request that carries the header — it
 * touches no table. Uncached on purpose: `fetchOrgStats` caches for an hour,
 * which is correct for a savings recap and wrong for a billing warning (a
 * balance that dropped mid-hour would stay invisible).
 *
 * Never throws. Returns null when the user is logged out, the request
 * fails or times out, or the header is missing/malformed — callers treat
 * null as "unknown" and stay silent rather than guess.
 */

import type { Credentials } from "../../commands/auth-creds.js";
import { log as _log } from "../../utils/debug.js";
import { isLocalMode } from "../../storage/local-mode.js";

const log = (msg: string) => _log("notifications-balance", msg);

const FETCH_TIMEOUT_MS = 1500;
const DEFAULT_API_URL = "https://api.deeplake.ai";

/** Cheapest query that still gets a response from the SQL endpoint. */
const PROBE_SQL = "SELECT 1";

/** Response header carrying the org's current prepaid balance, in cents. */
export const BALANCE_HEADER = "X-Activeloop-Balance-Cents";

export function parseBalanceHeader(headers: Headers | undefined): number | null {
  const raw = headers?.get?.(BALANCE_HEADER);
  if (!raw || !/^-?\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

export async function fetchBalanceCents(creds: Credentials | null): Promise<number | null> {
  if (isLocalMode()) return null;
  if (!creds?.token) return null;
  const apiUrl = creds.apiUrl ?? DEFAULT_API_URL;
  const workspaceId = creds.workspaceId ?? "default";
  const url = `${apiUrl}/workspaces/${encodeURIComponent(workspaceId)}/tables/query`;
  const ctrl = new AbortController();
  const timeoutHandle = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json",
        ...(creds.orgId ? { "X-Activeloop-Org-Id": creds.orgId } : {}),
      },
      body: JSON.stringify({ query: PROBE_SQL }),
      signal: ctrl.signal,
    });
    // The header is present on error responses too (a 402 carries the zero
    // balance that caused it), so we read it regardless of status.
    const cents = parseBalanceHeader(resp.headers);
    log(`balance read from ${url}: ${cents === null ? "unknown" : `${cents}c`} (status ${resp.status})`);
    return cents;
  } catch (e: any) {
    log(`balance read failed: ${e?.message ?? String(e)}`);
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
