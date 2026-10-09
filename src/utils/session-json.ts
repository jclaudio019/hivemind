/** Read-time compatibility for local rows carrying SQL-escaped JSON. Never
 * changes stored originals. Prefer valid JSON before undoing doubled slashes. */
export function parseSessionJson(raw: string): any {
  try { return JSON.parse(raw); } catch {
    try { return JSON.parse(raw.replace(/\\\\/g, '\\')); } catch { return null; }
  }
}
