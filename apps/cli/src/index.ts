import { decideRoute, shouldCheckForUpdates } from "./router";

if (process.platform === "win32") {
  console.error(
    "tp does not support native Windows. Run it inside WSL (Windows Subsystem for Linux) and install the Linux build.",
  );
  console.error("See https://learn.microsoft.com/windows/wsl/install");
  process.exit(1);
}

const command = process.argv[2];
const route = decideRoute(command);

async function main(): Promise<void> {
  if (shouldCheckForUpdates(route)) {
    // Fire and forget; errors inside are already swallowed.
    void import("./commands/upgrade").then(({ checkForUpdates }) =>
      checkForUpdates().then(async (newVersion) => {
        if (!newVersion) return;
        const { yellow } = await import("./lib/colors");
        console.error(
          yellow(
            `[tp] New version available: ${newVersion}. Run 'tp upgrade' to update.`,
          ),
        );
      }),
    );
  }

  switch (route.kind) {
    case "subcommand":
      await dispatchSubcommand(route.name);
      break;
    case "claude-utility": {
      const { forwardToClaudeCommand } = await import(
        "./commands/forward-claude"
      );
      await forwardToClaudeCommand(process.argv.slice(2));
      break;
    }
    case "forward-double-dash": {
      const { forwardToClaudeCommand } = await import(
        "./commands/forward-claude"
      );
      await forwardToClaudeCommand(process.argv.slice(3));
      break;
    }
    case "help": {
      const { helpCommand } = await import("./commands/help");
      await helpCommand();
      break;
    }
    case "version": {
      const { versionCommand } = await import("./commands/version");
      await versionCommand([]);
      break;
    }
    case "passthrough": {
      // Bare `tp` (no args) and any unrecognized first arg both fall through
      // to passthrough — claude is launched through the daemon+runner pipeline
      // with whatever args (if any) the user provided.
      const { passthroughCommand } = await import("./commands/passthrough");
      await passthroughCommand(process.argv.slice(2));
      break;
    }
  }
}

async function dispatchSubcommand(name: string): Promise<void> {
  const argv = process.argv.slice(3);
  switch (name) {
    case "daemon": {
      const { daemonCommand } = await import("./commands/daemon");
      await daemonCommand(argv);
      return;
    }
    case "run": {
      const { runCommand } = await import("./commands/run");
      await runCommand(argv);
      return;
    }
    case "relay": {
      const { relayCommand } = await import("./commands/relay");
      await relayCommand(argv);
      return;
    }
    case "pair": {
      const { pairCommand } = await import("./commands/pair");
      await pairCommand(argv);
      return;
    }
    case "session": {
      const { sessionCommand } = await import("./commands/session");
      await sessionCommand(argv);
      return;
    }
    case "status": {
      const { statusCommand } = await import("./commands/status");
      await statusCommand(argv);
      return;
    }
    case "logs": {
      const { logsCommand } = await import("./commands/logs");
      await logsCommand(argv);
      return;
    }
    case "doctor": {
      const { doctorCommand } = await import("./commands/doctor");
      await doctorCommand(argv);
      return;
    }
    case "upgrade": {
      const { upgradeCommand } = await import("./commands/upgrade");
      await upgradeCommand(argv);
      return;
    }
    case "completions": {
      const { completionsCommand } = await import("./commands/completions");
      completionsCommand(argv);
      return;
    }
    case "version": {
      const { versionCommand } = await import("./commands/version");
      await versionCommand(argv);
      return;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
