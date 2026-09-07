import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseWorktrees, Repository } from "../src/git.ts";
import { execute } from "../src/system.ts";
import { fixture, seedBaseBranches } from "./helpers.ts";

let context: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  context = await fixture();
});
afterEach(async () => {
  await context.cleanup();
});

test("create, find from a linked worktree, remove and keep the branch", async () => {
  const tree = await context.repo.create({ branch: "feature/login" });
  expect(tree.path).toBe(
    join(context.repo.worktreeDirectory, "repo with spaces", "feature--login"),
  );
  const linked = await Repository.open(tree.path, context.repo.worktreeDirectory);
  expect(await linked.suggestedPath("fix/startup")).toBe(
    join(context.repo.worktreeDirectory, "repo with spaces", "fix--startup"),
  );
  expect(linked.commonDir).toBe(context.repo.commonDir);
  expect((await linked.find()).path).toBe(tree.path);
  expect(await linked.list()).toHaveLength(2);
  await linked.git(["branch", "--list"]);
  await context.repo.remove(tree);
  expect(await stat(tree.path).catch(() => null)).toBeNull();
  expect(await context.repo.git(["branch", "--list"])).toContain("feature/login");
});

test("main, dirty, and locked worktrees cannot be removed", async () => {
  await expect(context.repo.remove(await context.repo.find())).rejects.toThrow("main worktree");
  const tree = await context.repo.create({ branch: "dirty" });
  const file = join(tree.path, "local.txt");
  await writeFile(file, "keep me");
  await expect(context.repo.remove(tree)).rejects.toThrow("local changes");
  expect(await readFile(file, "utf8")).toBe("keep me");
  await rm(file);
  await context.repo.git(["worktree", "lock", tree.path]);
  await expect(context.repo.remove(tree)).rejects.toThrow("locked");
});

test("unborn repository reports that the first commit is needed", async () => {
  const path = join(context.directory, "empty");
  await execute("git", ["init", path]);
  const repo = await Repository.open(path);
  expect(await repo.list()).toHaveLength(1);
  await expect(repo.create({ branch: "new" })).rejects.toThrow("first commit");
});

test("NUL worktree format preserves newline paths and detached metadata", () => {
  const trees = parseWorktrees(
    'worktree /tmp/a\n"b\0HEAD abc\0branch refs/heads/main\0\0' +
      "worktree /tmp/next\0HEAD def\0detached\0locked reason\0\0",
  );
  expect(trees[0]?.path).toBe('/tmp/a\n"b');
  expect(trees[1]?.branch).toBe("detached");
  expect(trees[1]?.locked).toBe(true);
});

test("existing branch checkout and destination collision", async () => {
  await context.repo.git(["branch", "existing"]);
  const tree = await context.repo.create({ branch: "existing", existing: true });
  expect(tree.branch).toBe("existing");
  await expect(context.repo.create({ branch: "other", path: tree.path })).rejects.toThrow(
    "already exists",
  );
  await expect(context.repo.create({ branch: "--orphan" })).rejects.toThrow("valid branch");
});

test("default storage is in the home directory and explicit destinations still work", async () => {
  const repo = await Repository.open(context.repo.root);
  expect(repo.worktreeDirectory).toBe(join(homedir(), ".worktree-managers"));
  const destination = join(context.directory, "custom-worktree");
  const tree = await repo.create({ branch: "custom", path: destination });
  expect(tree.path).toBe(destination);
});

test("colliding branch folder names get stable identifiers without changing branch names", async () => {
  const first = await context.repo.create({ branch: "feature/login" });
  const second = await context.repo.create({ branch: "feature--login" });
  expect(first.path).not.toBe(second.path);
  expect(second.path).toMatch(/feature--login--[a-f0-9]{8}$/);
  expect(second.branch).toBe("feature--login");
  expect(await context.repo.suggestedPath("feature--login")).toBe(second.path);
  expect((await context.repo.find("feature/login")).path).toBe(first.path);
});

test("same-named repositories use separate stable project folders", async () => {
  const otherPath = join(context.directory, "another", "repo with spaces");
  await context.repo.git(["clone", "--", context.repo.root, otherPath]);
  const other = await Repository.open(otherPath, context.repo.worktreeDirectory);
  const [first, second] = await Promise.all([
    context.repo.create({ branch: "feature/login" }),
    other.create({ branch: "feature/login" }),
  ]);
  expect(first.path).not.toBe(second.path);
  expect(
    [first.path, second.path].some((path) => /repo with spaces--[a-f0-9]{8}\//.test(path)),
  ).toBe(true);
  expect(await context.repo.suggestedPath("feature/login")).toBe(first.path);
  const reopened = await Repository.open(second.path, context.repo.worktreeDirectory);
  expect(await reopened.suggestedPath("feature/login")).toBe(second.path);
});

test("existing unmanaged folders are preserved when selecting default paths", async () => {
  const project = join(context.repo.worktreeDirectory, "repo with spaces");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "keep.txt"), "keep project");
  const destination = await context.repo.suggestedPath("fix/startup");
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "keep.txt"), "keep branch");
  const tree = await context.repo.create({ branch: "fix/startup" });
  expect(tree.path).not.toBe(destination);
  expect(await readFile(join(project, "keep.txt"), "utf8")).toBe("keep project");
  expect(await readFile(join(destination, "keep.txt"), "utf8")).toBe("keep branch");
});

test("lists local and remote bases without symbolic aliases and creates at the selected commit", async () => {
  const baseHead = await seedBaseBranches(context.repo);
  const originalHead = (await context.repo.find()).head;
  expect(baseHead).not.toBe(originalHead);
  const branches = await context.repo.branches();
  expect(branches.map((branch) => branch.name)).toEqual(["develop", "main", "origin/release"]);
  for (const [index, base] of branches.filter((branch) => branch.name !== "main").entries()) {
    const tree = await context.repo.create({ branch: `from-base-${index}`, base: base.ref });
    expect(tree.head).toBe(baseHead);
  }
  expect((await context.repo.find()).head).toBe(originalHead);
  await expect(
    context.repo.create({ branch: "invalid-base", base: "missing-ref" }),
  ).rejects.toThrow();
  expect(await context.repo.git(["branch", "--list", "invalid-base"])).toBe("");
});
