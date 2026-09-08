#!/usr/bin/env bun
import { Command, CommanderError } from "commander";
import { Repository } from "./git.ts";
import { Manager } from "./manager.ts";
import { errorMessage, WorktreeError } from "./types.ts";

export async function main(argv = process.argv): Promise<number> {
  const program = new Command()
    .name("wt")
    .version("0.2.0")
    .description("Worktree Manager · launch the mouse-friendly TUI with no subcommand.")
    .option("-C, --repo <path>", "Git repository directory", process.cwd())
    .exitOverride();
  const manager = async () => {
    if (!["darwin", "linux"].includes(process.platform))
      throw new WorktreeError("This version supports macOS and Linux. On Windows, use WSL.");
    return new Manager(await Repository.open(program.opts<{ repo: string }>().repo));
  };
  program
    .command("list")
    .description("List worktrees and listening ports")
    .option("--json", "Machine-readable output")
    .action(async (options: { json?: boolean }) => {
      const snapshot = await (await manager()).snapshot();
      if (options.json) {
        console.log(JSON.stringify(snapshot, null, 2));
        return;
      }
      console.log("BRANCH                    STATUS          PORTS           PATH");
      for (const ws of snapshot.worktrees) {
        console.log(
          `${(ws.tree.branch + (ws.tree.dirty ? " *" : "")).padEnd(26)}${ws.status.padEnd(16)}${([...new Set(ws.ports.map((p) => p.port))].join(", ") || "—").padEnd(16)}${ws.tree.path}`,
        );
      }
      if (snapshot.warning) console.error(snapshot.warning);
    });
  program
    .command("add <branch>")
    .description("Create a worktree")
    .option("--path <path>")
    .option("--base <ref>", "Base for a new branch", "HEAD")
    .option("--existing", "Check out an existing branch")
    .action(
      async (branch: string, options: { path?: string; base: string; existing?: boolean }) => {
        const tree = await (await manager()).repo.create({ branch, ...options });
        console.log(`Created ${tree.branch}: ${tree.path}`);
      },
    );
  program
    .command("remove <target>")
    .description("Remove a clean worktree; keep its branch")
    .option("-y, --yes", "Confirm directory removal")
    .action(async (target: string, options: { yes?: boolean }) => {
      const service = await manager();
      const tree = await service.repo.find(target);
      if (!options.yes)
        throw new WorktreeError(
          `To remove ${tree.path}, repeat with --yes. The Git branch will be kept.`,
        );
      await service.remove(tree);
      console.log(`Removed ${tree.path}; branch kept.`);
    });
  program
    .command("run [target]")
    .description("Start a detached development server")
    .option("-c, --command <command>", "Shell command; defaults to saved project command")
    .option("--port <number>", "Check availability and set PORT")
    .action(async (target: string | undefined, options: { command?: string; port?: string }) => {
      const service = await manager();
      const tree = await service.repo.find(target);
      const record = await service.start(
        tree,
        options.command ?? (await service.defaultCommand(tree)),
        options.port === undefined ? undefined : Number(options.port),
      );
      console.log(`Started ${tree.branch} · supervisor PID ${record.pid}\nLog: ${record.log}`);
    });
  program
    .command("stop [target]")
    .description("Stop this app's server process tree")
    .action(async (target?: string) => {
      const service = await manager();
      await service.stop(await service.repo.find(target));
      console.log("Server stopped.");
    });
  program
    .command("logs [target]")
    .description("Print the tail of the latest server log")
    .action(async (target?: string) => {
      const service = await manager();
      console.log(await service.logs(await service.repo.find(target)));
    });
  program.action(async () => {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new WorktreeError("Open wt in an interactive terminal, or use 'wt list --json'.");
    let service: Manager | undefined;
    try {
      service = await manager();
    } catch (error) {
      if (
        program.getOptionValueSource("repo") !== "default" ||
        !["darwin", "linux"].includes(process.platform)
      )
        throw error;
      // Outside a repository, open saved projects or the empty project picker.
    }
    const [{ createCliRenderer }, { WorktreeApp }] = await Promise.all([
      import("@opentui/core"),
      import("./app.ts"),
    ]);
    const renderer = await createCliRenderer({
      useMouse: true,
      exitOnCtrlC: true,
      backgroundColor: "#10151d",
    });
    const app = new WorktreeApp(service, renderer);
    await app.start();
  });
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    console.error(errorMessage(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
