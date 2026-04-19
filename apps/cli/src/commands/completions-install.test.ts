import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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

describe("installCompletion — safety", () => {
  test("preserves existing .zshrc mode when installing", () => {
    const file = join(home, ".zshrc");
    writeFileSync(file, "# prior\n");
    chmodSync(file, 0o600);
    installCompletion({ shell: "zsh", home });
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("new .bashrc gets mode 0o644", () => {
    installCompletion({ shell: "bash", home });
    const mode = statSync(join(home, ".bashrc")).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  test("dry-run distinguishes fresh / already-installed / force-rewrite", () => {
    const fresh = installCompletion({ shell: "bash", home, dryRun: true });
    expect((fresh as { plan: string }).plan).toContain("Would append");

    installCompletion({ shell: "bash", home });
    const skip = installCompletion({ shell: "bash", home, dryRun: true });
    expect((skip as { plan: string }).plan).toContain("Would skip");

    const rewrite = installCompletion({
      shell: "bash",
      home,
      dryRun: true,
      force: true,
    });
    expect((rewrite as { plan: string }).plan).toContain("Would rewrite");
  });
});

describe("installCompletion — fish", () => {
  test("creates ~/.config/fish/completions/tp.fish", () => {
    const result = installCompletion({ shell: "fish", home });
    expect(result.status).toBe("installed");
    const file = join(home, ".config", "fish", "completions", "tp.fish");
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("complete -c tp");
  });

  test("is idempotent: second install reports already-installed", () => {
    installCompletion({ shell: "fish", home });
    const result = installCompletion({ shell: "fish", home });
    expect(result.status).toBe("already-installed");
  });

  test("--force rewrites the file", () => {
    const file = join(home, ".config", "fish", "completions", "tp.fish");
    installCompletion({ shell: "fish", home });
    writeFileSync(file, "stale content\n");
    const result = installCompletion({ shell: "fish", home, force: true });
    expect(result.status).toBe("installed");
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("complete -c tp");
    expect(content).not.toContain("stale content");
  });

  test("--dry-run does not create the file", () => {
    const result = installCompletion({ shell: "fish", home, dryRun: true });
    expect(result.status).toBe("dry-run");
    expect(
      existsSync(join(home, ".config", "fish", "completions", "tp.fish")),
    ).toBe(false);
  });
});

describe("uninstallCompletion — fish", () => {
  test("removes the managed file", () => {
    installCompletion({ shell: "fish", home });
    const result = uninstallCompletion({ shell: "fish", home });
    expect(result.status).toBe("uninstalled");
    expect(
      existsSync(join(home, ".config", "fish", "completions", "tp.fish")),
    ).toBe(false);
  });

  test("reports not-installed when absent", () => {
    const result = uninstallCompletion({ shell: "fish", home });
    expect(result.status).toBe("not-installed");
  });
});

describe("installCompletion — powershell", () => {
  test("writes managed file and appends dot-source to profile", () => {
    const result = installCompletion({ shell: "powershell", home });
    expect(result.status).toBe("installed");

    const scriptFile = join(
      home,
      "Documents",
      "PowerShell",
      "tp-completions.ps1",
    );
    const profileFile = join(home, "Documents", "PowerShell", "Profile.ps1");

    expect(existsSync(scriptFile)).toBe(true);
    expect(readFileSync(scriptFile, "utf-8")).toContain(
      "Register-ArgumentCompleter",
    );

    const profile = readFileSync(profileFile, "utf-8");
    expect(profile).toContain("# >>> tp completions");
    expect(profile).toContain(`. "${scriptFile}"`);
    expect(profile).toContain("# <<< tp completions");
  });

  test("uses WindowsPowerShell path when legacyPowerShell=true", () => {
    installCompletion({ shell: "powershell", home, legacyPowerShell: true });
    expect(
      existsSync(
        join(home, "Documents", "WindowsPowerShell", "tp-completions.ps1"),
      ),
    ).toBe(true);
  });

  test("idempotent second install", () => {
    installCompletion({ shell: "powershell", home });
    const result = installCompletion({ shell: "powershell", home });
    expect(result.status).toBe("already-installed");
  });

  test("uninstall removes managed file and profile marker block", () => {
    const dir = join(home, "Documents", "PowerShell");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Profile.ps1"), "# user profile content\n");
    installCompletion({ shell: "powershell", home });

    const result = uninstallCompletion({ shell: "powershell", home });
    expect(result.status).toBe("uninstalled");
    expect(existsSync(join(dir, "tp-completions.ps1"))).toBe(false);

    const profile = readFileSync(join(dir, "Profile.ps1"), "utf-8");
    expect(profile).toContain("# user profile content");
    expect(profile).not.toContain("# >>> tp completions");
  });

  test("uninstall reports not-installed when nothing exists", () => {
    const result = uninstallCompletion({ shell: "powershell", home });
    expect(result.status).toBe("not-installed");
  });
});
