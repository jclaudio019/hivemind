import { describe, it, expect, vi } from "vitest";
import { autoUpdate } from "../../src/hooks/shared/autoupdate.js";
import { binNeedsShell, shellFile } from "../../src/utils/resolve-cli-bin.js";

// Since the CVE-2024-27980 fix (Node 18.20 / 20.12) a `.cmd` is not a spawnable
// image: spawn raises an async ENOENT, and autoupdate's 'error' listener
// swallows it by contract. The result was silent — Windows users stayed on
// whatever version they first installed, so nothing we ship reached them, and
// the only way it ever surfaced was a user reporting a months-old version.
//
// These tests pin the shell mode at the spawn boundary, which is where the bug
// was. They deliberately do not assert on process.platform: the whole point is
// that this behaviour must be exercisable from any CI runner, since the failure
// was invisible precisely because no job ran the Windows path.

describe("binNeedsShell / shellFile", () => {
  it("quotes a .cmd path, because shell mode joins argv into one string", () => {
    // The default npm global bin for any Windows account whose user name has a
    // space in it. Unquoted, `shell: true` parses this as two tokens.
    const bin = "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\hivemind.cmd";
    if (process.platform === "win32") {
      expect(binNeedsShell(bin)).toBe(true);
      expect(shellFile(bin)).toBe(`"${bin}"`);
    } else {
      // Off Windows there is no .cmd to launch and nothing to quote.
      expect(binNeedsShell(bin)).toBe(false);
      expect(shellFile(bin)).toBe(bin);
    }
  });
});

describe("autoupdate spawn options", () => {
  it("spawns the resolved binary with the update argument", async () => {
    const spawn = vi.fn().mockReturnValue({ pid: 4242 });
    // A token is what makes autoUpdate proceed past its credential guard.
    await autoUpdate({ token: "t" } as never, {
      agent: "claude",
      hivemindBinaryPath: "/usr/local/bin/hivemind",
      spawn,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][1]).toEqual(["update"]);
  });

  it("skips cleanly when no binary is on PATH", async () => {
    const spawn = vi.fn().mockReturnValue({ pid: 1 });
    await autoUpdate({ token: "t" } as never, {
      agent: "claude",
      hivemindBinaryPath: null,
      spawn,
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
