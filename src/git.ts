import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonical, execute } from "./system.ts";
import { type Worktree, WorktreeError } from "./types.ts";

export function parseWorktrees(raw: string): Worktree[] {
  const trees: Worktree[] = [];
  for (const block of raw.split("\0\0")) {
    const fields = new Map(
      block.split("\0").map((field) => {
        const space = field.indexOf(" ");
        return space < 0 ? [field, ""] : [field.slice(0, space), field.slice(space + 1)];
      }),
    );
    const path = fields.get("worktree");
    if (!path || fields.has("bare")) continue;
    trees.push({
      path,
      branch: (fields.get("branch") ?? "detached").replace(/^refs\/heads\//, ""),
      head: fields.get("HEAD") ?? "",
      main: trees.length === 0,
      locked: fields.has("locked"),
      prunable: fields.has("prunable"),
      dirty: false,
    });
  }
  return trees;
}

export interface CreateOptions {
  branch: string;
  path?: string;
  base?: string;
  existing?: boolean;
}

export interface BranchRef {
  name: string;
  ref: string;
  remote: boolean;
}

export class Repository {
  private constructor(
    readonly directory: string,
    readonly root: string,
    readonly commonDir: string,
  ) {}

  static async open(directory: string): Promise<Repository> {
    const path = await canonical(directory);
    const [root, common] = await Promise.all([
      Repository.command(path, ["rev-parse", "--show-toplevel"]),
      Repository.command(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ]);
    return new Repository(path, await canonical(root.trim()), await canonical(common.trim()));
  }

  static async command(directory: string, args: string[]): Promise<string> {
    const result = await execute("git", ["-C", directory, ...args]);
    if (result.code !== 0) throw new WorktreeError(result.stderr.trim() || "Git failed.");
    return result.stdout;
  }

  git(args: string[], directory = this.directory): Promise<string> {
    return Repository.command(directory, args);
  }

  async branches(): Promise<BranchRef[]> {
    const output = await this.git([
      "for-each-ref",
      "--sort=refname",
      "--format=%(refname)%00%(symref)",
      "refs/heads/",
      "refs/remotes/",
    ]);
    return output.split("\n").flatMap((line) => {
      const [ref, symbolic] = line.split("\0");
      if (!ref || symbolic) return [];
      return [
        {
          name: ref.replace(/^refs\/(heads|remotes)\//, ""),
          ref,
          remote: ref.startsWith("refs/remotes/"),
        },
      ];
    });
  }

  async list(): Promise<Worktree[]> {
    const trees = parseWorktrees(await this.git(["worktree", "list", "--porcelain", "-z"]));
    return Promise.all(
      trees.map(async (tree) => {
        tree.path = await canonical(tree.path);
        if (!tree.prunable && (await stat(tree.path).catch(() => null))?.isDirectory()) {
          tree.dirty = Boolean(
            await this.git(["status", "--porcelain", "-z", "--untracked-files=normal"], tree.path),
          );
        }
        return tree;
      }),
    );
  }

  async find(target = this.root): Promise<Worktree> {
    const trees = await this.list();
    const path = await canonical(target);
    let matches = trees.filter((tree) => tree.path === path || tree.branch === target);
    if (!matches.length) matches = trees.filter((tree) => basename(tree.path) === target);
    const match = matches[0];
    if (matches.length !== 1 || !match) {
      throw new WorktreeError(`Worktree is missing or ambiguous: ${target}. Use its full path.`);
    }
    return match;
  }

  async suggestedPath(branch: string): Promise<string> {
    const main = (await this.list())[0];
    if (!main) throw new WorktreeError("No worktrees found.");
    const slug =
      branch.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^[.-]+|[.-]+$/g, "") || "worktree";
    return join(dirname(main.path), `${basename(main.path)}.worktrees`, slug);
  }

  async create(options: CreateOptions): Promise<Worktree> {
    const branch = options.branch.trim();
    const base = options.base ?? "HEAD";
    if (!branch || branch.startsWith("-") || base.startsWith("-")) {
      throw new WorktreeError("Enter a valid branch name and base ref.");
    }
    await this.git(["check-ref-format", "--branch", branch]);
    try {
      await this.git(["rev-parse", "--verify", "HEAD"]);
    } catch {
      throw new WorktreeError("Create the repository's first commit before adding a worktree.");
    }
    const path = await canonical(options.path || (await this.suggestedPath(branch)));
    if (await stat(path).catch(() => null))
      throw new WorktreeError(`Destination already exists: ${path}`);
    await this.git([
      "worktree",
      "add",
      ...(options.existing ? [] : ["-b", branch]),
      "--",
      path,
      options.existing ? branch : base,
    ]);
    return this.find(path);
  }

  async remove(target: Worktree): Promise<void> {
    const tree = await this.find(target.path);
    if (tree.main) throw new WorktreeError("The main worktree cannot be removed.");
    if (tree.locked) throw new WorktreeError("This worktree is locked. Unlock it with Git first.");
    if (tree.dirty)
      throw new WorktreeError("This worktree has local changes. Commit or stash them first.");
    await this.git(["worktree", "remove", "--", tree.path]);
  }
}
