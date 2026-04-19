import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installCompletion, uninstallCompletion } from "./completions-install";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tp-completion-install-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("installCompletion — bash", () => {
  test("writes marker block to ~/.bashrc when file missing", () => {
    const result = installCompletion({ shell: "bash", home });
    expect(result.status).toBe("installed");

    const bashrc = readFileSync(join(home, ".bashrc"), "utf-8");
    expect(bashrc).toContain("# >>> tp completions");
    expect(bashrc).toContain('eval "$(tp completions bash)"');
    expect(bashrc).toContain("# <<< tp completions");
  });

  test("appends marker block to existing ~/.bashrc without touching other content", () => {
    writeFileSync(join(home, ".bashrc"), "export EDITOR=vim\n");
    installCompletion({ shell: "bash", home });
    const bashrc = readFileSync(join(home, ".bashrc"), "utf-8");
    expect(bashrc.startsWith("export EDITOR=vim\n")).toBe(true);
    expect(bashrc).toContain("# >>> tp completions");
  });

  test("is idempotent: second install reports already-installed", () => {
    installCompletion({ shell: "bash", home });
    const before = readFileSync(join(home, ".bashrc"), "utf-8");
    const result = installCompletion({ shell: "bash", home });
    expect(result.status).toBe("already-installed");
    const after = readFileSync(join(home, ".bashrc"), "utf-8");
    expect(after).toBe(before);
  });

  test("--force rewrites the block (no duplicates)", () => {
    installCompletion({ shell: "bash", home });
    const result = installCompletion({ shell: "bash", home, force: true });
    expect(result.status).toBe("installed");
    const bashrc = readFileSync(join(home, ".bashrc"), "utf-8");
    const markerCount = (bashrc.match(/# >>> tp completions/g) ?? []).length;
    expect(markerCount).toBe(1);
  });

  test("--dry-run reports plan without writing", () => {
    const result = installCompletion({ shell: "bash", home, dryRun: true });
    expect(result.status).toBe("dry-run");
    expect((result as { plan: string }).plan).toContain(join(home, ".bashrc"));
    expect(existsSync(join(home, ".bashrc"))).toBe(false);
  });
});

describe("uninstallCompletion — bash", () => {
  test("removes marker block, preserves other content", () => {
    writeFileSync(join(home, ".bashrc"), "export EDITOR=vim\n");
    installCompletion({ shell: "bash", home });
    const result = uninstallCompletion({ shell: "bash", home });
    expect(result.status).toBe("uninstalled");
    const bashrc = readFileSync(join(home, ".bashrc"), "utf-8");
    expect(bashrc).toBe("export EDITOR=vim\n");
  });

  test("exits cleanly when nothing is installed", () => {
    const result = uninstallCompletion({ shell: "bash", home });
    expect(result.status).toBe("not-installed");
  });
});

describe("installCompletion — zsh", () => {
  test("writes marker block to ~/.zshrc", () => {
    installCompletion({ shell: "zsh", home });
    const zshrc = readFileSync(join(home, ".zshrc"), "utf-8");
    expect(zshrc).toContain('eval "$(tp completions zsh)"');
  });
});
