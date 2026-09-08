import {
  BoxRenderable,
  type CliRenderer,
  type KeyEvent,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";
import { chooseFolder } from "./folder-picker.ts";
import { Repository } from "./git.ts";
import { Manager } from "./manager.ts";
import { portUrl } from "./process-info.ts";
import { type Project, Projects } from "./projects.ts";
import { ResizePointer } from "./resize-pointer.ts";
import { sleep } from "./system.ts";
import { errorMessage, type Workspace } from "./types.ts";
import { Controls } from "./ui/controls.ts";
import { type Dialog, Dialogs } from "./ui/dialogs.ts";
import { Notifications } from "./ui/notifications.ts";
import { ProjectNavigator } from "./ui/project-navigator.ts";
import { ProjectTooltip } from "./ui/project-tooltip.ts";
import { color } from "./ui/theme.ts";

export class WorktreeApp {
  projects: Project[] = [];
  private service?: Manager;
  private registry: Projects;
  workspaces: Workspace[] = [];
  selected: string;
  busy = false;
  private readonly dialogs: Dialogs;
  private disposed = false;
  private refreshing = false;
  private detailRevision = 0;
  private timer?: ReturnType<typeof setInterval>;
  private selection?: string;
  private readonly ui: Controls;
  private readonly notifications: Notifications;
  private root: BoxRenderable;
  private content: ScrollBoxRenderable;
  private body: BoxRenderable;
  private projectPanel: BoxRenderable;
  private splitDragOverlay: BoxRenderable;
  private readonly projectTooltip: ProjectTooltip;
  private projectRatio = 0.5;
  private resizingPanels = false;
  private resizePointer: ResizePointer;
  private projectList: ScrollBoxRenderable;
  private readonly navigator: ProjectNavigator;
  private detailPanel: BoxRenderable;
  private portList: ScrollBoxRenderable;
  private portEmpty: TextRenderable;
  private details: TextRenderable;
  private command: TextRenderable;
  private summary: TextRenderable;
  private portRows = new Map<string, { box: BoxRenderable; text: TextRenderable }>();
  private keyHandler = (key: KeyEvent) => this.onKey(key);
  private resizeHandler = () => {
    this.projectTooltip.hide();
    this.layout();
  };

  constructor(
    manager: Manager | undefined,
    readonly renderer: CliRenderer,
    registry = new Projects(manager?.repo.worktreeDirectory),
    private readonly pickProjectFolder:
      | (() => Promise<string | undefined>)
      | undefined = process.platform === "darwin" ? chooseFolder : undefined,
  ) {
    this.ui = new Controls(
      renderer,
      (scope) => !this.busy && (scope ? this.modal === scope : !this.modal),
      () => this.isMouseDrag(),
    );
    this.resizePointer = new ResizePointer(renderer);
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
    this.content = new ScrollBoxRenderable(renderer, {
      id: "content",
      flexGrow: 1,
      padding: 0,
      scrollX: false,
    });
    this.root.add(this.content);
    this.body = this.ui.box(this.content, "body", { flexDirection: "row", height: 20, gap: 1 });
    this.projectPanel = this.ui.panel(this.body, "project-panel", " PROJECTS ", {
      flexGrow: 1,
      flexBasis: 0,
    });
    this.projectList = new ScrollBoxRenderable(renderer, {
      id: "project-list",
      width: "100%",
      minWidth: 0,
      overflow: "hidden",
      onMouseScroll: () => {
        this.projectTooltip.hide();
      },
      flexGrow: 1,
      minHeight: 3,
      scrollX: false,
    });
    this.projectPanel.add(this.projectList);
    this.ui.focus.push(this.projectList);
    this.projectPanel.onMouseDown = (event) => {
      if (
        event.button !== 0 ||
        this.modal ||
        this.renderer.width < 95 ||
        event.x !== this.projectPanel.x + this.projectPanel.width - 1
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      this.projectTooltip.hide();
      this.resizingPanels = true;
      this.splitDragOverlay.visible = true;
      this.projectPanel.borderColor = color.accent;
      this.resizePointer.set(true);
    };
    this.projectPanel.onMouseMove = (event) => {
      if (this.resizingPanels) return;
      const draggable =
        !this.modal &&
        this.renderer.width >= 95 &&
        event.x === this.projectPanel.x + this.projectPanel.width - 1;
      this.projectPanel.borderColor = draggable ? color.accent : color.line;
      this.resizePointer.set(draggable);
    };
    this.projectPanel.onMouseOut = () => {
      if (!this.resizingPanels) {
        this.projectPanel.borderColor = color.line;
        this.resizePointer.set(false);
      }
    };
    this.detailPanel = this.ui.panel(this.body, "detail-panel", " SELECT A WORKTREE ", {
      flexGrow: 1,
      flexBasis: 0,
    });
    this.details = this.ui.text(this.detailPanel, "details", "", {
      height: 2,
      fg: color.muted,
      wrapMode: "none",
      truncate: true,
    });
    this.command = this.ui.text(this.detailPanel, "command", "", {
      height: 1,
      wrapMode: "none",
      truncate: true,
    });
    this.ui.text(this.detailPanel, "port-heading", "PORT   PROCESS                  SOURCE", {
      fg: color.muted,
    });
    this.portList = new ScrollBoxRenderable(renderer, {
      id: "ports",
      height: 1,
      flexShrink: 0,
      scrollX: false,
    });
    this.detailPanel.add(this.portList);
    this.portEmpty = this.ui.text(this.portList, "ports-empty", "No listening TCP ports", {
      height: 1,
      fg: color.muted,
    });
    this.ui.focus.push(this.portList);
    const first = this.ui.box(this.detailPanel, "actions-1", {
      height: 1,
      flexDirection: "row",
      gap: 1,
    });
    this.ui.button(
      first,
      "run",
      "▶ Run",
      () => {
        void this.openRun();
      },
      true,
    );
    this.ui.button(first, "stop", "■ Stop", () => this.stop());
    this.ui.button(first, "browser", "↗ Browser", () => this.browser());
    this.ui.button(first, "copy", "Copy URL", () => this.copy());
    const second = this.ui.box(this.detailPanel, "actions-2", {
      height: 1,
      flexDirection: "row",
      gap: 1,
    });
    this.ui.button(second, "editor", "Editor", () => this.editor());
    this.ui.button(second, "terminal", "Terminal", () => this.terminal());
    this.ui.button(second, "codex", "Open in Codex", () => this.codex());
    const toolbar = this.ui.box(this.root, "toolbar", {
      height: 1,
      flexDirection: "row",
      gap: 1,
      paddingX: 1,
    });
    this.ui.button(toolbar, "project-add", "+ Add project", () => this.openProjectAdd());
    this.ui.button(toolbar, "add", "n New worktree", () => this.openAdd());
    this.ui.button(toolbar, "remove", "d Remove", () => this.openRemove());
    this.ui.button(toolbar, "refresh", "F5 Refresh", () => {
      void this.refresh();
    });
    this.ui.button(toolbar, "quit", "q Quit", () => this.quit());
    this.summary = this.ui.text(toolbar, "summary", "Loading…", {
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      height: 1,
      wrapMode: "none",
      truncate: true,
      fg: color.muted,
    });
    this.notifications = new Notifications(this.ui, this.root);
    this.dialogs = new Dialogs(
      this.ui,
      this.root,
      () => this.resizePointer.set(false),
      () => this.projectList.focus(),
    );
    this.projectTooltip = new ProjectTooltip(
      renderer,
      this.root,
      () => Boolean(this.modal) || this.isMouseDrag(),
    );
    this.navigator = new ProjectNavigator(
      this.ui,
      this.projectPanel,
      this.projectList,
      this.projectTooltip,
      {
        state: () => ({
          projects: this.projects,
          workspaces: this.workspaces,
          commonDir: this.service?.repo.commonDir,
          selected: this.selected,
        }),
        selectTree: (path) => this.selectTree(path),
        selectProject: (path) => this.selectProject(path),
        focusProject: () => this.openProjects(),
      },
    );
    const projectTitle = this.projectPanel.findDescendantById("project-panel-title");
    if (projectTitle instanceof TextRenderable) this.projectTooltip.attach(projectTitle);
    // Capture the first movement even when it skips the one-cell panel border.
    this.splitDragOverlay = this.ui.box(this.root, "panel-split-drag", {
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 100,
      visible: false,
      onMouseDrag: (event) => {
        if (!this.splitDragOverlay.visible || event.button !== 0) return;
        event.stopPropagation();
        const available = this.body.width;
        this.projectRatio =
          this.clampProjectWidth(event.x - this.body.x + 1, available) / available;
        this.layout();
      },
      onMouseUp: (event) => {
        event.stopPropagation();
        this.splitDragOverlay.visible = false;
        this.projectPanel.borderColor = color.line;
        this.resizePointer.set(false);
        // OpenTUI also dispatches mouse-up to the element beneath its drag capture.
        queueMicrotask(() => {
          this.resizingPanels = false;
        });
      },
    });
    renderer.keyInput.on("keypress", this.keyHandler);
    renderer.on("resize", this.resizeHandler);
    renderer.once("destroy", () => this.dispose());
    this.layout();
    this.projectList.focus();
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
            break;
          } catch {
            /* Keep missing projects listed so their paths remain visible. */
          }
        }
      }
    } catch (error) {
      projectError = error;
    }
    this.navigator.renderProjects();
    await this.refresh();
    if (projectError) this.report(projectError);
    this.timer = setInterval(() => {
      void this.refresh();
    }, 2000);
    this.timer.unref();
  }

  dispose(): void {
    if (this.disposed) return;
    this.resizePointer.set(false);
    this.disposed = true;
    clearInterval(this.timer);
    this.notifications.dispose();
    this.dialogs.dispose();
    this.renderer.keyInput.off("keypress", this.keyHandler);
    this.renderer.off("resize", this.resizeHandler);
  }

  private clampProjectWidth(width: number, available: number): number {
    return Math.max(2, Math.min(available - 44, Math.round(width)));
  }

  private layout(): void {
    const narrow = this.renderer.width < 95;
    this.body.flexDirection = narrow ? "column" : "row";
    this.body.gap = narrow ? 1 : 0;
    if (narrow) {
      this.resizingPanels = false;
      this.resizePointer.set(false);
      this.splitDragOverlay.visible = false;
      this.projectPanel.borderColor = color.line;
    }
    const detailHeight = Math.max(9, this.portList.height + 8);
    this.notifications.resize(this.renderer.width);
    const projectHeight = Math.max(6, this.renderer.height - 2 - detailHeight);
    this.body.height = Math.max(
      narrow ? projectHeight + detailHeight + 1 : 10,
      this.renderer.height - 1,
    );
    this.projectPanel.height = narrow ? projectHeight : "100%";
    this.detailPanel.height = narrow ? detailHeight : "100%";
    const available = this.renderer.width;
    this.projectPanel.flexGrow = narrow ? 1 : 0;
    this.projectPanel.flexShrink = narrow ? 1 : 0;
    this.projectPanel.width = narrow
      ? "100%"
      : this.clampProjectWidth(available * this.projectRatio, available);
    const title = this.projectPanel.findDescendantById("project-panel-title");
    if (title instanceof TextRenderable) {
      const width = narrow ? this.renderer.width : Number(this.projectPanel.width);
      title.width = Math.max(0, width - 4);
      title.maxWidth = Math.max(0, width - 4);
      title.visible = width > 4;
      title.wrapMode = "none";
      title.truncate = true;
    }
    this.projectPanel.flexBasis = undefined;
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

        this.updateButtons();
        return;
      }
      const snapshot = await service.snapshot();
      if (service !== this.service || this.disposed || this.modal || (this.busy && !force)) return;
      this.workspaces = snapshot.worktrees;
      if (!this.current) this.selected = this.workspaces[0]?.tree.path ?? "";
      this.navigator.renderTrees();
      await this.updateDetails();
      if (service !== this.service) return;
      const running = this.workspaces.filter((ws) => ws.running).length;
      const ports = new Set(this.workspaces.flatMap((ws) => ws.ports.map((port) => port.port)))
        .size;
      this.summary.content = `${this.workspaces.length} trees · ${running} running · ${ports} ports`;
      this.notifications.warn(snapshot.warning);
    } catch (error) {
      this.report(error);
    } finally {
      this.refreshing = false;
    }
  }

  selectTree(path: string): void {
    if (this.busy || this.modal || !this.workspaces.some((ws) => ws.tree.path === path)) return;
    this.selected = path;
    this.selection = undefined;
    this.navigator.renderTrees();
    this.navigator.focusTree(path);
    void this.updateDetails().catch((error) => this.report(error));
  }

  private async updateDetails(): Promise<void> {
    const ws = this.current;
    if (!ws || this.disposed) return;
    const revision = ++this.detailRevision;
    const command = ws.run?.command || (await this.manager.defaultCommand(ws.tree));
    if (revision !== this.detailRevision || this.disposed) return;
    this.ui.setPanelTitle(this.detailPanel, ` ${ws.tree.branch} `);
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
        const box = this.ui.box(this.portList, `port:${key}`, {
          height: 1,
          focusable: true,
          onMouseUp: (event) => {
            if (event.button === 0 && !this.modal && !this.isMouseDrag()) {
              this.selection = key;
              void this.updateDetails().catch((error) => this.report(error));
            }
          },
        });
        row = { box, text: this.ui.text(box, `port-text:${key}`, "", { height: 1 }) };
        this.portRows.set(key, row);
      }
      row.text.content = `${port.port}   ${port.name} (${port.pid})   ${port.managed ? "Managed" : "External"}`;
      row.box.backgroundColor = key === this.selection ? color.selected : color.panel;
    }
    this.portEmpty.visible = ws.ports.length === 0;
    this.portList.height = Math.max(1, Math.min(8, ws.ports.length));
    this.layout();
    this.updateButtons();
  }

  private updateButtons(): void {
    const ws = this.current;
    for (const id of ["project-add", "quit"]) this.ui.enable(id, !this.busy);
    for (const project of this.projects)
      this.ui.enable(`project-choice:${project.commonDir}`, !this.busy);
    for (const id of ["add", "refresh"]) this.ui.enable(id, !this.busy && Boolean(this.service));
    for (const id of ["editor", "terminal"]) this.ui.enable(id, !this.busy && Boolean(ws));
    this.ui.enable("codex", !this.busy && Boolean(ws && !ws.tree.prunable));
    this.ui.enable(
      "run",
      !this.busy && Boolean(ws && !ws.running && !ws.tree.prunable && !ws.tree.statusError),
    );
    this.ui.enable("stop", !this.busy && Boolean(ws?.running));
    this.ui.enable(
      "remove",
      !this.busy &&
        Boolean(ws && !ws.tree.main && !ws.tree.locked && !ws.running && !ws.tree.statusError),
    );
    this.ui.enable("browser", !this.busy && Boolean(ws?.ports.length));
    this.ui.enable("copy", !this.busy && Boolean(ws?.ports.length));
  }

  private isMouseDrag(): boolean {
    if (this.resizingPanels) return true;
    const selection = this.renderer.getSelection();
    return Boolean(
      selection?.isDragging &&
        (selection.anchor.x !== selection.focus.x ||
          selection.anchor.y !== selection.focus.y ||
          selection.behavior !== "cell"),
    );
  }

  private onKey(key: KeyEvent): void {
    if ((key.super || key.meta) && key.name === "c") {
      const text = this.renderer.getSelection()?.getSelectedText();
      if (text) {
        key.preventDefault();
        key.stopPropagation();
        const copied = this.renderer.copyToClipboardOSC52(text);
        this.notifications.show(
          copied ? "Selected text copied" : "Clipboard unavailable",
          copied ? "success" : "error",
        );
        return;
      }
    }
    if (key.name === "tab") {
      key.preventDefault();
      this.modal?.closeDropdown?.();
      const items = (this.modal?.focus ?? this.ui.focus).filter(
        (item) => item.visible && item.focusable && (this.ui.buttons.get(item.id)?.enabled ?? true),
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
    if (key.name === "escape" && this.notifications.hasError) {
      key.preventDefault();
      this.notifications.dismiss();
      return;
    }
    if (this.busy) return;
    const focus = this.renderer.currentFocusedRenderable;
    if (
      (focus === this.projectList ||
        focus?.id.startsWith("tree:") ||
        focus?.id.startsWith("project-choice:")) &&
      ["up", "down", "left", "right"].includes(key.name)
    ) {
      key.preventDefault();
      this.navigator.navigate(key.name, focus);
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
    if (!key.ctrl && !key.meta && !key.super && !key.hyper) actions[key.name]?.();
  }

  get modal(): Dialog | undefined {
    return this.dialogs.active;
  }

  closeModal(): void {
    this.dialogs.close();
  }

  openProjects(): void {
    if (this.busy || this.modal) return;
    this.content.scrollChildIntoView(this.body.id);
    const active = this.ui.buttons.get(`project-choice:${this.service?.repo.commonDir}`);
    (active?.box ?? this.projectList).focus();
  }

  openProjectAdd(): void {
    if (this.busy || this.modal) return;
    this.dialogs.openProjectAdd(this.pickProjectFolder, (path, dialog) =>
      this.selectProject(path, dialog),
    );
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
      this.navigator.expanded = true;
      this.detailRevision++;
      this.workspaces = snapshot.worktrees;
      this.selected = service.repo.root;
      this.selection = undefined;
      this.navigator.renderProjects();
      this.closeModal();
      this.navigator.renderTrees();
      await this.updateDetails();
      this.summary.content = `${this.workspaces.length} trees`;
      this.notifications.show("Project switched · Other projects' servers keep running");
      this.notifications.warn(snapshot.warning);
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
    this.dialogs.openAdd(this.manager.repo, (options) => {
      this.closeModal();
      void this.perform(
        async () => {
          const tree = await this.manager.repo.create(options);
          this.selected = tree.path;
          this.navigator.setExpanded(true);
        },
        "Worktree created",
        "Creating worktree…",
      );
    });
  }

  async openRun(): Promise<void> {
    const ws = this.current;
    if (!ws || ws.running || this.busy || this.modal) return;
    try {
      const defaultCommand = ws.run?.command || (await this.manager.defaultCommand(ws.tree));
      if (this.current !== ws || this.modal || this.busy || this.disposed) return;
      this.dialogs.openRun(ws, defaultCommand, (command, port) => {
        this.closeModal();
        void this.perform(
          () => this.manager.start(ws.tree, command, port),
          "Server started",
          "Starting server…",
        );
      });
    } catch (error) {
      this.report(error);
    }
  }

  openRemove(): void {
    const ws = this.current;
    if (!ws || this.busy || this.modal || ws.tree.main || ws.tree.locked || ws.running) return;
    this.dialogs.openRemove(ws, () => {
      this.closeModal();
      void this.perform(
        () => this.manager.remove(ws.tree),
        "Worktree removed; branch kept",
        "Removing worktree…",
      );
    });
  }

  async perform(
    operation: () => Promise<unknown>,
    message: string,
    progress = "Working…",
  ): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.updateButtons();
    this.notifications.show(progress, "progress");
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
        else this.notifications.show(message);
      }
    }
  }

  stop(): void {
    const ws = this.current;
    if (ws?.running)
      void this.perform(() => this.manager.stop(ws.tree), "Server stopped", "Stopping server…");
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
    if (url) {
      const copied = this.renderer.copyToClipboardOSC52(url);
      this.notifications.show(
        copied ? `Copied ${url}` : `Clipboard unavailable · ${url}`,
        copied ? "success" : "error",
      );
    }
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
      this.notifications.show(errorMessage(error), "error");
    }
  }
}
