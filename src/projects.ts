import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import lockfile from "proper-lockfile";
import type { Repository } from "./git.ts";
import { writeJson } from "./store.ts";
import { isMissing } from "./system.ts";
import { WorktreeError } from "./types.ts";

export interface Project {
  name: string;
  path: string;
  commonDir: string;
}

export class Projects {
  readonly path: string;

  constructor(readonly directory = join(homedir(), ".worktree-managers")) {
    this.path = join(directory, ".projects.json");
  }

  async list(): Promise<Project[]> {
    try {
      const projects: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (
        !Array.isArray(projects) ||
        !projects.every(
          (project) =>
            project &&
            typeof project.name === "string" &&
            typeof project.path === "string" &&
            typeof project.commonDir === "string",
        )
      )
        throw new Error("Invalid project list");
      return projects;
    } catch (error) {
      if (isMissing(error)) return [];
      throw new WorktreeError(`Cannot read projects at ${this.path}: ${error}`);
    }
  }

  async add(repo: Repository): Promise<Project[]> {
    const main = (await repo.list())[0];
    if (!main) throw new WorktreeError("No worktrees found.");
    const project: Project = {
      name: basename(main.path),
      path: main.path,
      commonDir: repo.commonDir,
    };
    await mkdir(this.directory, { recursive: true });
    const release = await lockfile.lock(this.path, {
      realpath: false,
      retries: { retries: 60, minTimeout: 50, maxTimeout: 100 },
    });
    try {
      const projects = await this.list();
      const index = projects.findIndex((entry) => entry.commonDir === project.commonDir);
      if (index < 0) projects.push(project);
      else projects[index] = project;
      await writeJson(this.path, projects);
      return projects;
    } finally {
      await release();
    }
  }
}
