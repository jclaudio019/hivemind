import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeNpmPowerShellShim, runUpdate } from "../../src/cli/update.js";

// npm's cmd-shim writes three shims for every global bin: `hivemind`,
// `hivemind.cmd` and `hivemind.ps1`. At a PowerShell prompt the bare name
// resolves to the .ps1, which is subject to the execution policy, while the .cmd
// beside it is not — so under Restricted every later `hivemind ...` the user
// types dies with PSSecurityException on a machine where the working shim is
// right there. These tests pin the deletion AND its narrowness: this function
// removes files, so what it refuses to touch matters as much as what it removes.

// The shape cmd-shim actually generates, trimmed to the markers we key on.
const GENERATED_PS1 = `#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent
$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) { $exe=".exe" }
& "$basedir/node$exe" "$basedir/node_modules/@deeplake/hivemind/bundle/cli.js" $args
exit $LASTEXITCODE
`;

// A script a USER might write. It mentions hivemind and sets a $basedir, which
// is exactly what the old two-substring test accepted — and this function
// deletes what it matches.
const USER_OWNED_PS1 = `# my hivemind wrapper
$basedir = $PSScriptRoot
$env:HIVEMIND_WORKSPACE_ID = "payments"
& "$basedir\\hivemind.cmd" @args
`;

describe("removeNpmPowerShellShim", () => {
  let binDir: string;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "hivemind-shim-"));
  });
  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  it("removes npm's generated hivemind.ps1 when the working .cmd is beside it", () => {
    writeFileSync(join(binDir, "hivemind.ps1"), GENERATED_PS1);
    writeFileSync(join(binDir, "hivemind.cmd"), "@echo off\r\n");

    expect(removeNpmPowerShellShim({ platform: "win32", binDir })).toBe(true);
    expect(existsSync(join(binDir, "hivemind.ps1"))).toBe(false);
    // The two shims that actually work are untouched.
    expect(existsSync(join(binDir, "hivemind.cmd"))).toBe(true);
  });

  // Deleting the .ps1 when there is no .cmd would remove the only way to run it.
  it("refuses when there is no .cmd to fall back to", () => {
    writeFileSync(join(binDir, "hivemind.ps1"), GENERATED_PS1);

    expect(removeNpmPowerShellShim({ platform: "win32", binDir })).toBe(false);
    expect(existsSync(join(binDir, "hivemind.ps1"))).toBe(true);
  });

  // Never a glob, never a guessed path: only a file we positively identify as
  // the wrapper npm generated for this package.
  it("refuses a hivemind.ps1 that is not npm's generated shim", () => {
    const someonesScript = "# my own helper\nWrite-Host 'hello'\n";
    writeFileSync(join(binDir, "hivemind.ps1"), someonesScript);
    writeFileSync(join(binDir, "hivemind.cmd"), "@echo off\r\n");

    expect(removeNpmPowerShellShim({ platform: "win32", binDir })).toBe(false);
    expect(readFileSync(join(binDir, "hivemind.ps1"), "utf-8")).toBe(someonesScript);
  });

  // The finding that mattered: a delete path must identify its target, not
  // pattern-match two words that appear in unrelated files.
  it("refuses a user's own script that merely mentions hivemind and $basedir", () => {
    writeFileSync(join(binDir, "hivemind.ps1"), USER_OWNED_PS1);
    writeFileSync(join(binDir, "hivemind.cmd"), "@echo off\r\n");

    expect(removeNpmPowerShellShim({ platform: "win32", binDir })).toBe(false);
    expect(readFileSync(join(binDir, "hivemind.ps1"), "utf-8")).toBe(USER_OWNED_PS1);
  });

  // cmd-shim's preamble without OUR package is somebody else's shim.
  it("refuses a generated shim for a different package", () => {
    const otherPkg = GENERATED_PS1.replace("@deeplake/hivemind", "@someone/else");
    writeFileSync(join(binDir, "hivemind.ps1"), otherPkg);
    writeFileSync(join(binDir, "hivemind.cmd"), "@echo off\r\n");

    expect(removeNpmPowerShellShim({ platform: "win32", binDir })).toBe(false);
    expect(existsSync(join(binDir, "hivemind.ps1"))).toBe(true);
  });

  it("does nothing when there is no shim at all", () => {
    expect(removeNpmPowerShellShim({ platform: "win32", binDir })).toBe(false);
  });

  // The whole problem is Windows-only: on POSIX npm writes no .ps1, and a file
  // with that name belongs to someone else.
  it("does nothing off Windows", () => {
    writeFileSync(join(binDir, "hivemind.ps1"), GENERATED_PS1);
    writeFileSync(join(binDir, "hivemind.cmd"), "@echo off\r\n");

    expect(removeNpmPowerShellShim({ platform: "linux", binDir })).toBe(false);
    expect(existsSync(join(binDir, "hivemind.ps1"))).toBe(true);
  });
});

// The regression CI caught, pinned here so it cannot come back.
//
// The removal used to live only after the `npm install -g` inside runUpdate. A
// Windows user already on the latest version takes the "up to date" early return,
// so that call never ran and they kept a `hivemind.ps1` the execution policy
// blocks — permanently, because no version bump was ever coming to trigger it.
// Repairing local state must not be coupled to whether an upgrade happened.
describe("runUpdate --dry-run does not mutate", () => {
  // A preview that deletes a file is worse than the bug the repair was added
  // for. The repair used to run before the dryRun check.
  it("does not touch the shim under --dry-run", async () => {
    let called = false;
    const code = await runUpdate({
      dryRun: true,
      currentVersionOverride: "1.0.0",
      latestVersionOverride: "2.0.0",
      installKindOverride: { kind: "npm-global", installDir: "/tmp" },
      removeShim: () => { called = true; },
    });
    expect(code).toBe(0);
    expect(called, "removeShim ran during --dry-run").toBe(false);
  });

  // ...but a real invocation still repairs unconditionally, which is the whole
  // point of the earlier fix.
  it("still repairs on a real invocation", async () => {
    let called = false;
    await runUpdate({
      currentVersionOverride: "9.9.9",
      latestVersionOverride: "9.9.9",
      removeShim: () => { called = true; },
    });
    expect(called).toBe(true);
  });
});

describe("runUpdate repairs the shim before it can return early", () => {
  it("removes the shim even when already on the latest version", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "hivemind-shim-update-"));
    try {
      writeFileSync(join(binDir, "hivemind.ps1"), GENERATED_PS1);
      writeFileSync(join(binDir, "hivemind.cmd"), "@echo off\r\n");

      // The "up to date" path: latest equals current, so runUpdate returns 0
      // without ever reaching the npm install.
      const code = await runUpdate({
        currentVersionOverride: "9.9.9",
        latestVersionOverride: "9.9.9",
        removeShim: () => { removeNpmPowerShellShim({ platform: "win32", binDir }); },
      });

      expect(code).toBe(0);
      expect(existsSync(join(binDir, "hivemind.ps1"))).toBe(false);
      expect(existsSync(join(binDir, "hivemind.cmd"))).toBe(true);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
