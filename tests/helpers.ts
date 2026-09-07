import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quote } from "shell-quote";
import { Repository } from "../src/git.ts";
import { Manager } from "../src/manager.ts";
import { isLive, processTable } from "../src/process-info.ts";
import { canonical, execute, sleep } from "../src/system.ts";

export async function fixture() {
  const directory = await canonical(await mkdtemp(join(tmpdir(), "wt-ts-")));
  const path = join(directory, "repo with spaces");
  await execute("git", ["init", "-b", "main", path]);
  for (const [key, value] of [
    ["user.name", "Tests"],
    ["user.email", "tests@example.invalid"],
    ["commit.gpgsign", "false"],
  ]) {
    await execute("git", ["-C", path, "config", String(key), String(value)]);
  }
  await writeFile(join(path, "README.md"), "test repository\n");
  await execute("git", ["-C", path, "add", "."]);
  await execute("git", ["-C", path, "commit", "-m", "Initial"]);
  const repo = await Repository.open(path, join(directory, ".worktree-managers"));
  const manager = new Manager(repo);
  return {
    directory,
    repo,
    manager,
    async cleanup() {
      for (const [treePath, record] of Object.entries((await manager.store.read()).runs)) {
        if (isLive(record, await processTable())) await manager.stop(await repo.find(treePath));
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function seedBaseBranches(repo: Repository): Promise<string> {
  await repo.git(["checkout", "-b", "develop"]);
  await repo.git(["commit", "--allow-empty", "-m", "Base branch commit"]);
  const head = (await repo.git(["rev-parse", "HEAD"])).trim();
  await repo.git(["checkout", "main"]);
  await repo.git(["update-ref", "refs/remotes/origin/release", head]);
  await repo.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/release"]);
  return head;
}

export function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("test") });
  const port = server.port;
  server.stop(true);
  if (!port) throw new Error("No port assigned");
  return port;
}

export function serverCommand(port: number): string {
  return quote([process.execPath, join(import.meta.dir, "fixtures/server.ts"), String(port)]);
}

export async function connects(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(200) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function eventually(predicate: () => boolean | Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error("Timed out waiting for condition");
}
