import type { BoxRenderable, Renderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import type { Project } from "../projects.ts";
import type { Workspace } from "../types.ts";
import type { Controls } from "./controls.ts";
import type { ProjectTooltip } from "./project-tooltip.ts";
import { color } from "./theme.ts";

interface NavigationState {
  projects: readonly Project[];
  workspaces: readonly Workspace[];
  commonDir?: string;
  selected: string;
}

interface NavigationActions {
  state: () => NavigationState;
  selectTree: (path: string) => void;
  selectProject: (path: string) => Promise<void>;
  focusProject: () => void;
}

export class ProjectNavigator {
  expanded = true;
  private treeContainer?: BoxRenderable;
  private readonly treeRows = new Map<string, { box: BoxRenderable; text: TextRenderable }>();

  constructor(
    private readonly ui: Controls,
    private readonly projectPanel: BoxRenderable,
    private readonly projectList: ScrollBoxRenderable,
    private readonly projectTooltip: ProjectTooltip,
    private readonly actions: NavigationActions,
  ) {}

  private get state(): NavigationState {
    return this.actions.state();
  }

  focusTree(path: string): void {
    this.treeRows.get(path)?.box.focus();
    this.projectList.scrollChildIntoView(`tree:${path}`);
  }

  renderTrees(): void {
    if (!this.treeContainer) return;
    const paths = new Set(this.state.workspaces.map((ws) => ws.tree.path));
    for (const [path, row] of this.treeRows) {
      if (!paths.has(path)) {
        row.box.destroyRecursively();
        this.treeRows.delete(path);
      }
    }
    for (const ws of this.state.workspaces) {
      let row = this.treeRows.get(ws.tree.path);
      if (!row) {
        const box = this.ui.box(this.treeContainer, `tree:${ws.tree.path}`, {
          height: 1,
          focusable: true,
          onMouseUp: (event) => {
            if (event.button === 0 && this.ui.canInvoke() && !this.ui.isMouseDrag())
              this.actions.selectTree(ws.tree.path);
          },
          onKeyDown: (key) => {
            if (key.name === "return" || key.name === "space") {
              key.preventDefault();
              this.actions.selectTree(ws.tree.path);
            }
          },
        });
        const text = this.ui.text(box, `tree-text:${ws.tree.path}`, "", {
          height: 1,
          width: "100%",
          wrapMode: "none",
          truncate: true,
        });
        row = { box, text };
        this.treeRows.set(ws.tree.path, row);
      }
      const flags = `${ws.tree.dirty ? " *" : ""}${ws.tree.main ? " [main]" : ""}${ws.tree.locked ? " [locked]" : ""}${ws.tree.prunable ? " [missing]" : ""}${ws.tree.statusError ? " [Git error]" : ""}`;
      const connector = ws === this.state.workspaces.at(-1) ? "└─" : "├─";
      const ports = [...new Set(ws.ports.map((port) => port.port))].join(", ");
      row.text.content = `${connector} ${ws.tree.branch}${flags} · ${ws.status}${ports ? ` · ${ports}` : ""}`;
      this.projectTooltip.attach(row.text, () => ws.tree.branch);
      row.box.backgroundColor = ws.tree.path === this.state.selected ? color.selected : color.panel;
    }
  }

  renderProjects(): void {
    this.projectTooltip.hide();
    this.ui.focus = this.ui.focus.filter((item) => !item.id.startsWith("project-choice:"));
    for (const id of this.ui.buttons.keys()) {
      if (id.startsWith("project-choice:")) this.ui.buttons.delete(id);
    }
    this.treeRows.clear();
    this.treeContainer = undefined;
    for (const child of this.projectList.getChildren()) {
      child.destroyRecursively();
    }
    this.ui.setPanelTitle(this.projectPanel, ` PROJECTS (${this.state.projects.length}) `);
    for (const project of this.state.projects) {
      const active = project.commonDir === this.state.commonDir;
      const group = this.ui.box(this.projectList, `project-group:${project.commonDir}`, {
        marginBottom: 0,
      });
      const button = this.ui.button(
        group,
        `project-choice:${project.commonDir}`,
        this.projectLabel(project),
        () => {
          if (active) this.setExpanded(!this.expanded);
          else void this.actions.selectProject(project.path);
        },
        false,
        undefined,
      );
      button.flexGrow = 0;
      button.flexBasis = "auto";
      button.height = 1;
      button.width = "100%";
      button.minWidth = 0;
      button.overflow = "hidden";
      button.paddingLeft = 0;
      button.paddingRight = 0;
      button.border = false;
      const label = this.ui.buttons.get(button.id)?.text;
      if (label) {
        label.width = "100%";
        label.height = 1;
        label.wrapMode = "none";
        label.truncate = true;
        this.projectTooltip.attach(label, () => project.name);
      }
      button.backgroundColor = active ? color.raised : color.panel;
      button.on("focused", () => {
        button.backgroundColor = color.selected;
        this.projectList.scrollChildIntoView(button.id);
      });
      button.on("blurred", () => {
        button.backgroundColor = active ? color.raised : color.panel;
      });
      if (active) {
        this.treeContainer = this.ui.box(group, "project-worktrees", {
          marginLeft: 2,
          visible: this.expanded,
        });
      }
    }
    if (!this.state.projects.length)
      this.ui.text(
        this.projectList,
        "projects-empty",
        "No projects yet.\nAdd a local Git repository.",
      );
    this.renderTrees();
  }

  private projectLabel(project: Project): string {
    const active = project.commonDir === this.state.commonDir;
    return `${active && this.expanded ? "▾" : "▸"} ${active ? "● " : ""}${project.name}`;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    if (this.treeContainer) this.treeContainer.visible = expanded;
    const project = this.state.projects.find((item) => item.commonDir === this.state.commonDir);
    if (!project) return;
    const header = this.ui.buttons.get(`project-choice:${project.commonDir}`);
    if (header) {
      header.text.content = this.projectLabel(project);
      if (!expanded) header.box.focus();
    }
  }

  navigate(direction: string, focus?: Renderable | null): void {
    const project = this.state.projects.find(
      (item) => `project-choice:${item.commonDir}` === focus?.id,
    );
    if (direction === "left") {
      if (focus?.id.startsWith("tree:")) this.actions.focusProject();
      else if (project?.commonDir === this.state.commonDir) this.setExpanded(false);
      return;
    }
    if (direction === "right") {
      if (!project) return;
      if (project.commonDir !== this.state.commonDir) void this.actions.selectProject(project.path);
      else if (!this.expanded) this.setExpanded(true);
      else {
        const first = this.state.workspaces[0];
        if (first) {
          this.treeRows.get(first.tree.path)?.box.focus();
          this.actions.selectTree(first.tree.path);
        }
      }
      return;
    }
    const items: Renderable[] = [];
    for (const entry of this.state.projects) {
      const header = this.ui.buttons.get(`project-choice:${entry.commonDir}`)?.box;
      if (header) items.push(header);
      if (entry.commonDir === this.state.commonDir && this.expanded) {
        for (const ws of this.state.workspaces) {
          const row = this.treeRows.get(ws.tree.path)?.box;
          if (row) items.push(row);
        }
      }
    }
    const index = focus ? items.indexOf(focus) : -1;
    const next =
      items[Math.max(0, Math.min(items.length - 1, index + (direction === "up" ? -1 : 1)))];
    if (!next) return;
    next.focus();
    this.projectList.scrollChildIntoView(next.id);
    if (next.id.startsWith("tree:")) this.actions.selectTree(next.id.slice("tree:".length));
  }
}
