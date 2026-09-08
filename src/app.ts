import { stripVTControlCharacters } from "node:util";
import {
  BoxRenderable,
  type CliRenderer,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  type Renderable,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";
import { chooseFolder } from "./folder-picker.ts";
import { type BranchRef, Repository } from "./git.ts";
import { Manager } from "./manager.ts";
import { portUrl } from "./process-info.ts";
import { type Project, Projects } from "./projects.ts";
import { sleep } from "./system.ts";
import { errorMessage, type Workspace } from "./types.ts";

const color = {
  bg: "#10151d",
  panel: "#151f2c",
  raised: "#233145",
  line: "#35465c",
  text: "#e3e9f2",
  muted: "#9bacc2",
  accent: "#73e2b7",
  selected: "#254e45",
  error: "#ff938f",
};

interface Button {
  box: BoxRenderable;
  text: TextRenderable;
  enabled: boolean;
  primary: boolean;
}

interface Dialog {
  kind: "add" | "run" | "remove" | "project-add";
  overlay: BoxRenderable;
  panel: BoxRenderable;
  fields: Map<string, InputRenderable>;
  focus: Renderable[];
  error: TextRenderable;
  submit: () => void;
  closeDropdown?: () => boolean;
}

export class WorktreeApp {
  projects: Project[] = [];
  private service?: Manager;
  private registry: Projects;
  private repoLabel: TextRenderable;
  workspaces: Workspace[] = [];
  selected: string;
  busy = false;
  modal?: Dialog;
  private disposed = false;
  private refreshing = false;
  private detailRevision = 0;
  private timer?: ReturnType<typeof setInterval>;
  private selection?: string;
  private root: BoxRenderable;
  private content: ScrollBoxRenderable;
  private body: BoxRenderable;
  private projectPanel: BoxRenderable;
  private projectList: ScrollBoxRenderable;
  private treePanel: BoxRenderable;
  private detailPanel: BoxRenderable;
  private treeList: ScrollBoxRenderable;
  private portList: ScrollBoxRenderable;
  private details: TextRenderable;
  private command: TextRenderable;
  private summary: TextRenderable;
  private status: TextRenderable;
  private logPanel: ScrollBoxRenderable;
  private logText: TextRenderable;
  private logContent = "";
  private buttons = new Map<string, Button>();
  private treeRows = new Map<string, { box: BoxRenderable; text: TextRenderable }>();
  private portRows = new Map<string, { box: BoxRenderable; text: TextRenderable }>();
  private focus: Renderable[] = [];
  private keyHandler = (key: KeyEvent) => this.onKey(key);
  private resizeHandler = () => this.layout();

  constructor(
    manager: Manager | undefined,
    readonly renderer: CliRenderer,
    registry = new Projects(manager?.repo.worktreeDirectory),
    private readonly pickProjectFolder:
      | (() => Promise<string | undefined>)
      | undefined = process.platform === "darwin" ? chooseFolder : undefined,
  ) {
    this.service = manager;
    this.registry = registry;
    this.selected = manager?.repo.root ?? "";
    this.root = new BoxRenderable(renderer, {
      id: "app",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: color.bg,
    });
    renderer.root.add(this.root);
    const masthead = this.box(this.root, "masthead", {
      height: 1,
      backgroundColor: color.panel,
      paddingX: 2,
    });
    this.repoLabel = this.text(masthead, "repo", manager?.repo.root ?? "No project selected", {
      fg: color.muted,
    });
    const toolbar = this.box(this.root, "toolbar", {
      height: 3,
      flexDirection: "row",
      gap: 1,
      paddingX: 1,
    });
    this.button(toolbar, "add", "+ New worktree", () => this.openAdd(), true, 18);
    this.button(toolbar, "remove", "Remove", () => this.openRemove(), false, 10);
    this.button(
      toolbar,
      "refresh",
      "Refresh",
      () => {
        void this.refresh();
      },
      false,
      11,
    );
    this.button(toolbar, "quit", "Quit", () => this.quit(), false, 8);
    this.summary = this.text(toolbar, "summary", "Loading…", {
      marginTop: 1,
      flexGrow: 1,
      fg: color.muted,
    });
    this.content = new ScrollBoxRenderable(renderer, {
      id: "content",
      flexGrow: 1,
      padding: 1,
      scrollX: false,
    });
    this.root.add(this.content);
    this.body = this.box(this.content, "body", { flexDirection: "row", height: 20, gap: 1 });
    this.projectPanel = this.panel(this.body, "project-panel", " PROJECTS ", { width: 28 });
    this.button(
      this.projectPanel,
      "project-add",
      "+ Add project",
      () => this.openProjectAdd(),
      false,
      18,
    );
    this.projectList = new ScrollBoxRenderable(renderer, {
      id: "project-list",
      flexGrow: 1,
      minHeight: 3,
      scrollX: false,
    });
    this.projectPanel.add(this.projectList);
    this.focus.push(this.projectList);
    this.treePanel = this.panel(this.body, "tree-panel", " WORKTREES ", {
      flexGrow: 1,
      flexBasis: 0,
    });
    this.treeList = new ScrollBoxRenderable(renderer, { id: "trees", flexGrow: 1, scrollX: false });
    this.treePanel.add(this.treeList);
    this.focus.push(this.treeList);
    this.detailPanel = this.panel(this.body, "detail-panel", " SELECT A WORKTREE ", {
      flexGrow: 1,
      flexBasis: 0,
    });
    this.details = this.text(this.detailPanel, "details", "", { height: 3, fg: color.muted });
    this.command = this.text(this.detailPanel, "command", "", { height: 2 });
    this.text(this.detailPanel, "port-heading", "PORT   PROCESS                  SOURCE", {
      fg: color.muted,
    });
    this.portList = new ScrollBoxRenderable(renderer, {
      id: "ports",
      flexGrow: 1,
      minHeight: 3,
      scrollX: false,
    });
    this.detailPanel.add(this.portList);
    this.focus.push(this.portList);
    const first = this.box(this.detailPanel, "actions-1", {
      height: 3,
      flexDirection: "row",
      gap: 1,
    });
    this.button(
      first,
      "run",
      "▶ Run",
      () => {
        void this.openRun();
      },
      true,
    );
    this.button(first, "stop", "■ Stop", () => this.stop());
    this.button(first, "browser", "↗ Browser", () => this.browser());
    const second = this.box(this.detailPanel, "actions-2", {
      height: 3,
      flexDirection: "row",
      gap: 1,
    });
    this.button(second, "copy", "Copy URL", () => this.copy());
    this.button(second, "editor", "Editor", () => this.editor());
    this.button(second, "terminal", "Terminal", () => this.terminal());
    const third = this.box(this.detailPanel, "actions-3", { height: 3 });
    this.button(third, "codex", "Open in Codex", () => this.codex());
    this.logPanel = new ScrollBoxRenderable(renderer, {
      id: "logs",
      height: 8,
      marginTop: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: color.line,
      backgroundColor: color.panel,
      paddingX: 1,
      scrollX: false,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    this.content.add(this.logPanel);
    this.setPanelTitle(this.logPanel, " SERVER OUTPUT ");
    this.logText = this.text(this.logPanel, "log-text", "Run a server to see its output here.");
    this.focus.push(this.logPanel);
    this.status = this.text(this.root, "status", "Loading repository…", {
      height: 1,
      paddingX: 1,
      fg: color.muted,
    });
    this.text(
      this.root,
      "footer",
      " p Projects   n New   r Run   s Stop   o Browser   e Editor   F5 Refresh   q Quit   Tab Navigate   Ctrl+Y Copy ",
      { height: 1, bg: color.raised, fg: color.accent },
    );
    renderer.keyInput.on("keypress", this.keyHandler);
    renderer.on("resize", this.resizeHandler);
    renderer.once("destroy", () => this.dispose());
    this.layout();
    this.treeList.focus();
  }

  get current(): Workspace | undefined {
    return this.workspaces.find((ws) => ws.tree.path === this.selected);
  }

  get manager(): Manager {
    if (!this.service) throw new Error("Add a project first.");
    return this.service;
  }

  async start(): Promise<void> {
    let projectError: unknown;
    try {
      this.projects = this.service
        ? await this.registry.add(this.service.repo)
        : await this.registry.list();
      if (!this.service) {
        for (const project of this.projects) {
          try {
            this.service = new Manager(
              await Repository.open(project.path, this.registry.directory),
            );
            this.selected = this.service.repo.root;
            this.repoLabel.content = this.service.repo.root;
            break;
          } catch {
            /* Keep missing projects listed so their paths remain visible. */
          }
        }
      }
    } catch (error) {
      projectError = error;
    }
    this.renderProjects();
    await this.refresh();
    if (projectError) this.report(projectError);
    this.timer = setInterval(() => {
      void this.refresh();
    }, 2000);
    this.timer.unref();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.renderer.keyInput.off("keypress", this.keyHandler);
    this.renderer.off("resize", this.resizeHandler);
  }

  private box(
    parent: BoxRenderable,
    id: string,
    options: Partial<ConstructorParameters<typeof BoxRenderable>[1]> = {},
  ) {
    const box = new BoxRenderable(this.renderer, {
      id,
      flexDirection: "column",
      flexShrink: 0,
      ...options,
    });
    parent.add(box);
    return box;
  }

  private panel(
    parent: BoxRenderable,
    id: string,
    title: string,
    options: Partial<ConstructorParameters<typeof BoxRenderable>[1]> = {},
  ) {
    const panel = this.box(parent, id, {
      border: true,
      borderStyle: "rounded",
      borderColor: color.line,
      backgroundColor: color.panel,
      paddingX: 1,
      ...options,
    });
    this.setPanelTitle(panel, title);
    return panel;
  }

  private setPanelTitle(panel: BoxRenderable, title: string): void {
    const id = `${panel.id}-title`;
    const container = panel instanceof ScrollBoxRenderable ? panel.wrapper : panel;
    const existing = container.findDescendantById(id);
    if (existing instanceof TextRenderable) {
      existing.content = title;
      return;
    }
    this.text(container, id, title, {
      position: "absolute",
      top: -1,
      left: 1,
      height: 1,
      maxWidth: "90%",
      fg: color.accent,
      bg: color.panel,
    });
  }

  private text(
    parent: BoxRenderable,
    id: string,
    content: string,
    options: Partial<ConstructorParameters<typeof TextRenderable>[1]> = {},
  ) {
    const text = new TextRenderable(this.renderer, {
      id,
      content,
      fg: color.text,
      flexShrink: 0,
      selectable: true,
      selectionBg: color.accent,
      selectionFg: color.bg,
      ...options,
    });
    parent.add(text);
    return text;
  }

  private button(
    parent: BoxRenderable,
    id: string,
    label: string,
    action: () => void,
    primary = false,
    width?: number,
    dialog?: Dialog,
  ) {
    const invoke = () => {
      if (
        !this.busy &&
        (dialog ? this.modal === dialog : !this.modal) &&
        this.buttons.get(id)?.enabled
      )
        action();
    };
    const box = this.box(parent, id, {
      height: 3,
      width,
      flexGrow: width ? 0 : 1,
      flexBasis: width ? undefined : 0,
      minWidth: 7,
      border: true,
      borderColor: color.line,
      focusedBorderColor: color.accent,
      backgroundColor: primary ? color.accent : color.raised,
      focusable: true,
      alignItems: "center",
      justifyContent: "center",
      onMouseUp: (event) => {
        if (event.button === 0 && !this.isTextDrag()) invoke();
      },
      onKeyDown: (key) => {
        if (key.name === "return" || key.name === "space") {
          key.preventDefault();
          invoke();
        }
      },
    });
    const text = this.text(box, `${id}-label`, label, { fg: primary ? color.bg : color.text });
    this.buttons.set(id, { box, text, enabled: true, primary });
    (dialog?.focus ?? this.focus).push(box);
    return box;
  }

  private enable(id: string, enabled: boolean): void {
    const button = this.buttons.get(id);
    if (!button) return;
    button.enabled = enabled;
    button.box.opacity = enabled ? 1 : 0.4;
  }

  private layout(): void {
    const narrow = this.renderer.width < 110;
    this.body.flexDirection = narrow ? "column" : "row";
    this.body.height = narrow ? 44 : Math.max(21, this.renderer.height - 18);
    this.projectPanel.width = narrow ? "100%" : 28;
    this.projectPanel.height = narrow ? 10 : "100%";
    this.treePanel.height = narrow ? 10 : "100%";
    this.detailPanel.height = narrow ? 22 : "100%";
    this.treePanel.flexBasis = narrow ? undefined : 0;
    this.detailPanel.flexBasis = narrow ? undefined : 0;
    this.summary.visible = !narrow;
    if (this.modal) {
      this.modal.panel.width = Math.min(72, this.renderer.width - 4);
      this.modal.panel.left = Math.max(
        0,
        Math.floor((this.renderer.width - this.modal.panel.width) / 2),
      );
    }
  }

  async refresh(force = false): Promise<void> {
    if (this.refreshing || (this.busy && !force) || this.modal || this.disposed) return;
    this.refreshing = true;
    const service = this.service;
    try {
      if (!service) {
        this.summary.content = "No project selected";
        this.status.content = "Click + Add project to register a local Git repository.";
        this.updateButtons();
        return;
      }
      const snapshot = await service.snapshot();
      if (service !== this.service || this.disposed || this.modal || (this.busy && !force)) return;
      this.workspaces = snapshot.worktrees;
      if (!this.current) this.selected = this.workspaces[0]?.tree.path ?? "";
      this.renderTrees();
      await this.updateDetails();
      if (service !== this.service) return;
      const running = this.workspaces.filter((ws) => ws.running).length;
      const ports = new Set(this.workspaces.flatMap((ws) => ws.ports.map((port) => port.port)))
        .size;
      this.summary.content = `${this.workspaces.length} trees · ${running} running · ${ports} ports`;
      this.status.content =
        snapshot.warning ||
        "Click a worktree or port · Refreshes every 2s · Quit keeps servers running";
    } catch (error) {
      this.report(error);
    } finally {
      this.refreshing = false;
    }
  }

  private renderTrees(): void {
    const paths = new Set(this.workspaces.map((ws) => ws.tree.path));
    for (const [path, row] of this.treeRows) {
      if (!paths.has(path)) {
        row.box.destroyRecursively();
        this.treeRows.delete(path);
      }
    }
    for (const ws of this.workspaces) {
      let row = this.treeRows.get(ws.tree.path);
      if (!row) {
        const box = this.box(this.treeList, `tree:${ws.tree.path}`, {
          height: 2,
          focusable: true,
          onMouseUp: (event) => {
            if (event.button === 0 && !this.modal && !this.isTextDrag())
              this.selectTree(ws.tree.path);
          },
        });
        const text = this.text(box, `tree-text:${ws.tree.path}`, "", { height: 2 });
        row = { box, text };
        this.treeRows.set(ws.tree.path, row);
      }
      const flags = `${ws.tree.dirty ? " *" : ""}${ws.tree.main ? " [main]" : ""}${ws.tree.locked ? " [locked]" : ""}${ws.tree.prunable ? " [missing]" : ""}${ws.tree.statusError ? " [Git error]" : ""}`;
      row.text.content = `${ws.tree.branch}${flags}\n${ws.status}  ·  ${[...new Set(ws.ports.map((port) => port.port))].join(", ") || "No ports"}`;
      row.box.backgroundColor = ws.tree.path === this.selected ? color.selected : color.panel;
    }
  }

  selectTree(path: string): void {
    if (this.modal || !this.workspaces.some((ws) => ws.tree.path === path)) return;
    this.selected = path;
    this.selection = undefined;
    this.logContent = "";
    this.renderTrees();
    this.treeList.scrollChildIntoView(`tree:${path}`);
    void this.updateDetails().catch((error) => this.report(error));
  }

  private async updateDetails(): Promise<void> {
    const ws = this.current;
    if (!ws || this.disposed) return;
    const revision = ++this.detailRevision;
    const [command, logs] = await Promise.all([
      ws.run?.command || this.manager.defaultCommand(ws.tree),
      this.manager.logs(ws.tree),
    ]);
    if (revision !== this.detailRevision || this.disposed) return;
    this.setPanelTitle(this.detailPanel, ` ${ws.tree.branch} `);
    this.details.content = `${ws.tree.path}\n${ws.status}`;
    this.command.content = ws.tree.statusError || command || "No server command yet";
    const keys = new Set(ws.ports.map((port) => `${port.pid}:${port.port}`));
    for (const [key, row] of this.portRows) {
      if (!keys.has(key)) {
        row.box.destroyRecursively();
        this.portRows.delete(key);
      }
    }
    if (!this.selection || !keys.has(this.selection)) this.selection = keys.values().next().value;
    for (const port of ws.ports) {
      const key = `${port.pid}:${port.port}`;
      let row = this.portRows.get(key);
      if (!row) {
        const box = this.box(this.portList, `port:${key}`, {
          height: 1,
          focusable: true,
          onMouseUp: (event) => {
            if (event.button === 0 && !this.modal && !this.isTextDrag()) {
              this.selection = key;
              void this.updateDetails().catch((error) => this.report(error));
            }
          },
        });
        row = { box, text: this.text(box, `port-text:${key}`, "", { height: 1 }) };
        this.portRows.set(key, row);
      }
      row.text.content = `${port.port}   ${port.name} (${port.pid})   ${port.managed ? "Managed" : "External"}`;
      row.box.backgroundColor = key === this.selection ? color.selected : color.panel;
    }
    this.portList.bottomTitle = ws.ports.length
      ? " Select a port, then Browser "
      : " No listening TCP ports ";
    this.updateButtons();
    this.setPanelTitle(this.logPanel, ` SERVER OUTPUT / ${ws.tree.branch} `);
    if (logs !== this.logContent) {
      this.logText.content = stripVTControlCharacters(logs);
      if (!this.logContent) this.logPanel.scrollTo(999999);
      this.logContent = logs;
    }
  }

  private updateButtons(): void {
    const ws = this.current;
    for (const id of ["project-add", "quit"]) this.enable(id, !this.busy);
    for (const project of this.projects)
      this.enable(`project-choice:${project.commonDir}`, !this.busy);
    for (const id of ["add", "refresh"]) this.enable(id, !this.busy && Boolean(this.service));
    for (const id of ["editor", "terminal"]) this.enable(id, !this.busy && Boolean(ws));
    this.enable("codex", !this.busy && Boolean(ws && !ws.tree.prunable));
    this.enable(
      "run",
      !this.busy && Boolean(ws && !ws.running && !ws.tree.prunable && !ws.tree.statusError),
    );
    this.enable("stop", !this.busy && Boolean(ws?.running));
    this.enable(
      "remove",
      !this.busy &&
        Boolean(ws && !ws.tree.main && !ws.tree.locked && !ws.running && !ws.tree.statusError),
    );
    this.enable("browser", !this.busy && Boolean(ws?.ports.length));
    this.enable("copy", !this.busy && Boolean(ws?.ports.length));
  }

  private isTextDrag(): boolean {
    const selection = this.renderer.getSelection();
    return Boolean(
      selection?.isDragging &&
        (selection.anchor.x !== selection.focus.x ||
          selection.anchor.y !== selection.focus.y ||
          selection.behavior !== "cell"),
    );
  }

  private onKey(key: KeyEvent): void {
    if ((key.ctrl && key.name === "y") || (key.meta && key.name === "c")) {
      const text = this.renderer.getSelection()?.getSelectedText();
      if (text) {
        key.preventDefault();
        key.stopPropagation();
        this.status.content = this.renderer.copyToClipboardOSC52(text)
          ? "Selected text copied"
          : "Clipboard unavailable";
        return;
      }
    }
    if (key.name === "tab") {
      key.preventDefault();
      this.modal?.closeDropdown?.();
      const items = (this.modal?.focus ?? this.focus).filter(
        (item) => item.visible && item.focusable && (this.buttons.get(item.id)?.enabled ?? true),
      );
      const focused = this.renderer.currentFocusedRenderable;
      const index = focused ? items.indexOf(focused) : -1;
      items[(index + (key.shift ? -1 : 1) + items.length) % items.length]?.focus();
      return;
    }
    if (this.modal) {
      if (key.name === "escape") {
        key.preventDefault();
        if (this.modal.closeDropdown?.()) return;
        this.closeModal();
      }
      return;
    }
    if (this.busy) return;
    const focus = this.renderer.currentFocusedRenderable;
    if (
      (focus === this.treeList || focus?.id.startsWith("tree:")) &&
      ["up", "down"].includes(key.name)
    ) {
      key.preventDefault();
      const index = this.workspaces.findIndex((ws) => ws.tree.path === this.selected);
      const next =
        this.workspaces[
          Math.max(0, Math.min(this.workspaces.length - 1, index + (key.name === "up" ? -1 : 1)))
        ];
      if (next) this.selectTree(next.tree.path);
      return;
    }
    if (
      (focus === this.portList || focus?.id.startsWith("port:")) &&
      ["up", "down"].includes(key.name)
    ) {
      key.preventDefault();
      const keys = [...this.portRows.keys()];
      const index = keys.indexOf(this.selection ?? "");
      this.selection =
        keys[Math.max(0, Math.min(keys.length - 1, index + (key.name === "up" ? -1 : 1)))];
      if (this.selection) this.portList.scrollChildIntoView(`port:${this.selection}`);
      void this.updateDetails().catch((error) => this.report(error));
      return;
    }
    const actions: Record<string, () => void> = {
      p: () => this.openProjects(),
      n: () => this.openAdd(),
      r: () => {
        void this.openRun();
      },
      s: () => this.stop(),
      d: () => this.openRemove(),
      o: () => this.browser(),
      e: () => this.editor(),
      t: () => this.terminal(),
      f5: () => {
        void this.refresh();
      },
      q: () => this.quit(),
    };
    if (!key.ctrl && !key.meta) actions[key.name]?.();
  }

  private createDialog(kind: Dialog["kind"], title: string, height: number): Dialog {
    const overlay = this.box(this.root, "modal", {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 100,
      backgroundColor: "#080e18",
    });
    const width = Math.min(72, this.renderer.width - 4);
    const panel = this.panel(overlay, "dialog", ` ${title} `, {
      position: "absolute",
      width,
      height: Math.min(height, this.renderer.height),
      top: Math.max(0, Math.floor((this.renderer.height - height) / 2)),
      left: Math.floor((this.renderer.width - width) / 2),
      borderColor: color.accent,
      paddingX: 2,
    });
    const error = new TextRenderable(this.renderer, {
      id: "form-error",
      content: "",
      fg: color.error,
      height: 2,
      selectable: true,
      selectionBg: color.accent,
      selectionFg: color.bg,
    });
    const dialog: Dialog = {
      kind,
      overlay,
      panel,
      error,
      fields: new Map(),
      focus: [],
      submit: () => {},
    };
    this.modal = dialog;
    return dialog;
  }

  private field(
    dialog: Dialog,
    id: string,
    label: string,
    value = "",
    placeholder = "",
    parent = dialog.panel,
  ) {
    this.text(parent, `${id}-label`, label, { height: 1, fg: color.muted });
    const input = new InputRenderable(this.renderer, {
      id,
      value,
      placeholder,
      width: "100%",
      marginBottom: 1,
      backgroundColor: color.raised,
      focusedBackgroundColor: color.selected,
      textColor: color.text,
    });
    parent.add(input);
    dialog.fields.set(id, input);
    dialog.focus.push(input);
    input.on(InputRenderableEvents.ENTER, () => dialog.submit());
    return input;
  }

  private dialogActions(dialog: Dialog, label: string): void {
    dialog.panel.add(dialog.error);
    const actions = this.box(dialog.panel, "dialog-actions", {
      height: 3,
      flexDirection: "row",
      gap: 1,
    });
    this.button(actions, "cancel", "Cancel", () => this.closeModal(), false, undefined, dialog);
    this.button(actions, "submit", label, () => dialog.submit(), true, undefined, dialog);
    dialog.focus[0]?.focus();
  }

  closeModal(): void {
    this.modal?.overlay.destroyRecursively();
    this.modal = undefined;
    for (const id of ["cancel", "submit", "existing", "project-browse"]) this.buttons.delete(id);
    this.treeList.focus();
  }

  openProjects(): void {
    if (this.busy || this.modal) return;
    this.content.scrollChildIntoView(this.body.id);
    const active = this.buttons.get(`project-choice:${this.service?.repo.commonDir}`);
    (active?.box ?? this.buttons.get("project-add")?.box)?.focus();
  }

  private renderProjects(): void {
    this.focus = this.focus.filter((item) => !item.id.startsWith("project-choice:"));
    for (const child of this.projectList.getChildren()) {
      this.buttons.delete(child.id);
      child.destroyRecursively();
    }
    this.setPanelTitle(this.projectPanel, ` PROJECTS (${this.projects.length}) `);
    for (const project of this.projects) {
      const active = project.commonDir === this.service?.repo.commonDir;
      const button = this.button(
        this.projectList,
        `project-choice:${project.commonDir}`,
        `${active ? "● " : ""}${project.name}\n${project.path}`,
        () => {
          void this.selectProject(project.path);
        },
        false,
        undefined,
      );
      button.flexGrow = 0;
      button.flexBasis = "auto";
      button.height = 4;
      const label = this.buttons.get(button.id)?.text;
      if (label) {
        label.width = "100%";
        label.height = 2;
        label.wrapMode = "none";
        label.truncate = true;
      }
      button.backgroundColor = active ? color.selected : color.raised;
      button.borderColor = active ? color.accent : color.line;
      button.on("focused", () => this.projectList.scrollChildIntoView(button.id));
    }
    if (!this.projects.length)
      this.text(
        this.projectList,
        "projects-empty",
        "No projects yet.\nAdd a local Git repository.",
      );
  }

  openProjectAdd(): void {
    if (this.busy || this.modal) return;
    const dialog = this.createDialog("project-add", "Add project", 12);
    const row = this.box(dialog.panel, "project-path-row", {
      height: 3,
      flexDirection: "row",
      gap: 1,
    });
    const pathColumn = this.box(row, "project-path-column", {
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 0,
      flexDirection: "column",
    });
    const path = this.field(
      dialog,
      "project-path",
      "Local Git repository path",
      "",
      "~/code/my-project",
      pathColumn,
    );
    let picking = false;
    const pickFolder = this.pickProjectFolder;
    if (pickFolder) {
      this.button(
        row,
        "project-browse",
        "Choose folder…",
        () => {
          if (picking) return;
          picking = true;
          dialog.error.content = "";
          this.enable("project-browse", false);
          this.enable("submit", false);
          void pickFolder()
            .then((selected) => {
              if (this.disposed || this.modal !== dialog) return;
              if (selected !== undefined) path.value = selected;
            })
            .catch((error) => {
              if (!this.disposed && this.modal === dialog)
                dialog.error.content = errorMessage(error);
            })
            .finally(() => {
              picking = false;
              if (this.disposed || this.modal !== dialog) return;
              this.enable("project-browse", true);
              this.enable("submit", true);
              path.focus();
            });
        },
        false,
        18,
        dialog,
      );
    }
    this.text(
      dialog.panel,
      "project-hint",
      "Register an existing repository. Its files stay in place.",
      { height: 2, fg: color.muted },
    );
    dialog.submit = () => {
      if (picking) return;
      if (!path.value.trim()) {
        dialog.error.content = "Enter a repository path.";
        return;
      }
      void this.selectProject(path.value.trim(), dialog);
    };
    this.dialogActions(dialog, "Add & switch");
  }

  private async selectProject(path: string, dialog?: Dialog): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.updateButtons();
    try {
      const service = new Manager(await Repository.open(path, this.registry.directory));
      const snapshot = await service.snapshot();
      if (this.disposed || this.modal !== dialog) return;
      const projects = await this.registry.add(service.repo);
      if (this.disposed || this.modal !== dialog) return;
      this.projects = projects;
      this.service = service;
      this.detailRevision++;
      this.workspaces = snapshot.worktrees;
      this.selected = service.repo.root;
      this.selection = undefined;
      this.logContent = "";
      this.logText.content = "Run a server to see its output here.";
      this.repoLabel.content = service.repo.root;
      this.renderProjects();
      this.closeModal();
      this.renderTrees();
      await this.updateDetails();
      this.summary.content = `${this.workspaces.length} trees`;
      this.status.content =
        snapshot.warning || "Project switched · Other projects' servers keep running";
    } catch (error) {
      if (dialog && this.modal === dialog) dialog.error.content = errorMessage(error);
      else this.report(error);
    } finally {
      this.busy = false;
      this.updateButtons();
    }
  }

  openAdd(): void {
    if (this.busy || this.modal || !this.service) return;
    const dialog = this.createDialog("add", "New worktree", 24);
    const branch = this.field(dialog, "branch", "Branch", "", "feature/login");
    const path = this.field(
      dialog,
      "path",
      "Directory · optional",
      "",
      "Default: ~/.worktree-managers/<project>/<branch>",
    );
    const base = this.field(
      dialog,
      "base",
      "Base branch / ref ▾ · click or ↓ to open, type to filter",
      "HEAD",
    );
    let existing = false;
    const choices = new ScrollBoxRenderable(this.renderer, {
      id: "base-branches",
      height: 4,
      flexShrink: 1,
      minHeight: 1,
      scrollX: false,
      backgroundColor: color.raised,
      visible: false,
    });
    dialog.panel.add(choices);
    dialog.focus.push(choices);
    const hint = this.text(
      dialog.panel,
      "base-hint",
      "Loading local and fetched remote branches…",
      {
        height: 1,
        fg: color.muted,
      },
    );
    const head: BranchRef = { name: "HEAD", ref: "HEAD", remote: false };
    let branches: BranchRef[] = [head];
    let filtered = branches;
    let selectedBase: BranchRef | undefined = head;
    let cursor = 0;
    let picking = false;
    let rows: BoxRenderable[] = [];
    const closeDropdown = () => {
      if (!choices.visible) return false;
      if (choices.focused) base.focus();
      choices.visible = false;
      choices.focusable = false;
      return true;
    };
    dialog.closeDropdown = closeDropdown;
    choices.focusable = false;
    const highlight = () => {
      for (const [index, row] of rows.entries()) {
        row.backgroundColor = index === cursor ? color.selected : color.raised;
      }
      const row = rows[cursor];
      if (row) choices.scrollChildIntoView(row.id);
    };
    const pick = (index: number) => {
      const choice = filtered[index];
      if (existing || !choice) return;
      picking = true;
      base.value = choice.name;
      picking = false;
      selectedBase = choice;
      cursor = index;
      highlight();
      closeDropdown();
      base.focus();
    };
    const renderBranches = () => {
      for (const child of choices.getChildren()) child.destroyRecursively();
      const query = base.value.trim().toLowerCase();
      filtered = branches.filter(
        (branch) =>
          selectedBase ||
          !query ||
          query === "head" ||
          branch.name.toLowerCase().includes(query) ||
          branch.ref.toLowerCase().includes(query),
      );
      cursor = Math.max(
        0,
        filtered.findIndex((branch) => branch.ref === selectedBase?.ref),
      );
      rows = filtered.map((branch, index) => {
        const row = this.box(choices, `base-branch:${branch.ref}`, {
          height: 1,
          onMouseUp: (event) => {
            if (event.button === 0 && !this.isTextDrag()) pick(index);
          },
        });
        const source =
          branch.ref === "HEAD" ? "current checkout" : branch.remote ? "remote" : "local";
        this.text(row, `base-branch-label:${branch.ref}`, `${branch.name}  ·  ${source}`, {
          height: 1,
        });
        return row;
      });
      if (!rows.length)
        this.text(choices, "base-empty", "No matching branches · you can enter a ref or commit.", {
          height: 1,
          fg: color.muted,
        });
      choices.scrollTo(0);
      highlight();
    };
    const openDropdown = () => {
      if (existing) return;
      choices.visible = true;
      choices.focusable = true;
      renderBranches();
    };
    base.onMouseDown = (event) => {
      if (event.button === 0) openDropdown();
    };
    base.removeAllListeners(InputRenderableEvents.ENTER);
    base.on(InputRenderableEvents.ENTER, () => {
      if (choices.visible) pick(cursor);
      else openDropdown();
    });
    base.on(InputRenderableEvents.INPUT, () => {
      if (picking) return;
      selectedBase = undefined;
      openDropdown();
    });
    base.onKeyDown = (key) => {
      if (key.name === "down" && !existing) {
        key.preventDefault();
        openDropdown();
        choices.focus();
      }
    };
    choices.onKeyDown = (key) => {
      if (existing) return;
      if (key.name === "return" || key.name === "space") {
        key.preventDefault();
        pick(cursor);
      } else if (key.name === "up" || key.name === "down") {
        key.preventDefault();
        cursor = Math.max(0, Math.min(filtered.length - 1, cursor + (key.name === "up" ? -1 : 1)));
        highlight();
      }
    };
    renderBranches();
    void this.manager.repo
      .branches()
      .then((refs) => {
        if (this.modal !== dialog || this.disposed) return;
        branches = [head, ...refs];
        renderBranches();
        if (!existing) hint.content = "Local + fetched remote branches · ↑/↓ then Enter to choose";
      })
      .catch((error) => {
        if (this.modal === dialog && !this.disposed) dialog.error.content = errorMessage(error);
      });
    this.button(
      dialog.panel,
      "existing",
      "[ ] Use an existing branch",
      () => {
        existing = !existing;
        closeDropdown();
        const toggle = this.buttons.get("existing");
        if (toggle) toggle.text.content = `${existing ? "[x]" : "[ ]"} Use an existing branch`;
        base.focusable = !existing;
        base.opacity = choices.opacity = existing ? 0.4 : 1;
        hint.content = existing
          ? "Base is not used when checking out an existing branch."
          : "Local + fetched remote branches · ↑/↓ then Enter to choose";
      },
      false,
      undefined,
      dialog,
    );
    dialog.submit = () => {
      if (!branch.value.trim()) {
        dialog.error.content = "Enter a branch name.";
        return;
      }
      const options = {
        branch: branch.value.trim(),
        path: path.value.trim() || undefined,
        base: existing ? undefined : (selectedBase?.ref ?? (base.value.trim() || "HEAD")),
        existing,
      };
      this.closeModal();
      void this.perform(async () => {
        const tree = await this.manager.repo.create(options);
        this.selected = tree.path;
      }, "Worktree created");
    };
    this.dialogActions(dialog, "Create worktree");
  }

  async openRun(): Promise<void> {
    const ws = this.current;
    if (!ws || ws.running || this.busy || this.modal) return;
    try {
      const defaultCommand = ws.run?.command || (await this.manager.defaultCommand(ws.tree));
      if (this.current !== ws || this.modal || this.busy || this.disposed) return;
      const dialog = this.createDialog("run", "Run development server", 17);
      this.text(dialog.panel, "run-branch", ws.tree.branch, { height: 1, fg: color.accent });
      const command = this.field(
        dialog,
        "command-input",
        "Shell command · saved as project default",
        defaultCommand,
        "pnpm dev",
      );
      const port = this.field(
        dialog,
        "port-input",
        "PORT environment variable · optional",
        ws.run?.port ? String(ws.run.port) : "",
        "3000",
      );
      this.text(
        dialog.panel,
        "run-hint",
        "Checks availability and sets PORT. Your command must use it,\nor add its own --port flag. Servers keep running when you quit.",
        { height: 3, fg: color.muted },
      );
      dialog.submit = () => {
        const raw = port.value.trim();
        const selectedPort = raw ? Number(raw) : undefined;
        if (!command.value.trim()) {
          dialog.error.content = "Enter a server command.";
          return;
        }
        if (
          selectedPort !== undefined &&
          (!/^\d+$/.test(raw) || selectedPort < 1 || selectedPort > 65535)
        ) {
          dialog.error.content = "Port must be between 1 and 65535.";
          return;
        }
        const value = command.value.trim();
        this.closeModal();
        void this.perform(() => this.manager.start(ws.tree, value, selectedPort), "Server started");
      };
      this.dialogActions(dialog, "Run server");
    } catch (error) {
      this.report(error);
    }
  }

  openRemove(): void {
    const ws = this.current;
    if (!ws || this.busy || this.modal || ws.tree.main || ws.tree.locked || ws.running) return;
    const dialog = this.createDialog("remove", "Remove worktree?", 13);
    this.text(
      dialog.panel,
      "remove-description",
      `${ws.tree.branch}\n${ws.tree.path}\n\nThe directory will be removed. The Git branch will be kept.`,
      { height: 6 },
    );
    dialog.submit = () => {
      this.closeModal();
      void this.perform(() => this.manager.remove(ws.tree), "Worktree removed; branch kept");
    };
    this.dialogActions(dialog, "Remove worktree");
  }

  async perform(operation: () => Promise<unknown>, message: string): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.updateButtons();
    this.status.content = "Working…";
    let failure: unknown;
    try {
      await operation();
    } catch (error) {
      failure = error;
    } finally {
      if (!this.disposed) {
        while (this.refreshing && !this.disposed) await sleep(10);
        await this.refresh(true);
        this.busy = false;
        this.updateButtons();
        if (failure) this.report(failure);
        else this.status.content = message;
      }
    }
  }

  stop(): void {
    const ws = this.current;
    if (ws?.running) void this.perform(() => this.manager.stop(ws.tree), "Server stopped");
  }
  private chosenUrl(): string | undefined {
    const ws = this.current;
    const port = ws?.ports.find((p) => `${p.pid}:${p.port}` === this.selection) ?? ws?.ports[0];
    return port ? portUrl(port) : undefined;
  }
  browser(): void {
    const url = this.chosenUrl();
    if (url) void this.perform(() => this.manager.openBrowser(url), `Opened ${url}`);
  }
  copy(): void {
    const url = this.chosenUrl();
    if (url)
      this.status.content = this.renderer.copyToClipboardOSC52(url)
        ? `Copied ${url}`
        : `Clipboard unavailable · ${url}`;
  }
  editor(): void {
    const tree = this.current?.tree;
    if (tree) void this.perform(() => this.manager.openEditor(tree), "Opened editor");
  }
  codex(): void {
    const tree = this.current?.tree;
    if (tree && !tree.prunable)
      void this.perform(() => this.manager.openCodex(tree), `Opened in Codex · ${tree.branch}`);
  }
  terminal(): void {
    const tree = this.current?.tree;
    if (tree) void this.perform(() => this.manager.openTerminal(tree), "Opened terminal");
  }
  quit(): void {
    if (!this.busy) {
      this.dispose();
      this.renderer.destroy();
    }
  }
  private report(error: unknown): void {
    if (!this.disposed) {
      this.status.content = errorMessage(error);
      this.status.fg = color.error;
    }
  }
}
