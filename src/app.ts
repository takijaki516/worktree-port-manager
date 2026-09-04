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
import type { Manager } from "./manager.ts";
import { portUrl } from "./process-info.ts";
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
  kind: "add" | "run" | "remove";
  overlay: BoxRenderable;
  panel: BoxRenderable;
  fields: Map<string, InputRenderable>;
  focus: Renderable[];
  error: TextRenderable;
  submit: () => void;
}

export class WorktreeApp {
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
    readonly manager: Manager,
    readonly renderer: CliRenderer,
  ) {
    this.selected = manager.repo.root;
    this.root = new BoxRenderable(renderer, {
      id: "app",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: color.bg,
    });
    renderer.root.add(this.root);
    const masthead = this.box(this.root, "masthead", {
      height: 2,
      backgroundColor: color.panel,
      paddingX: 2,
    });
    this.text(masthead, "brand", "◈  WORKTREE MANAGER   /   TypeScript", { fg: color.accent });
    this.text(masthead, "repo", manager.repo.root, { fg: color.muted });
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
    this.logPanel = new ScrollBoxRenderable(renderer, {
      id: "logs",
      height: 8,
      marginTop: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: color.line,
      title: " SERVER OUTPUT ",
      backgroundColor: color.panel,
      paddingX: 1,
      scrollX: false,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    this.content.add(this.logPanel);
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
      " n New   r Run   s Stop   o Browser   e Editor   F5 Refresh   q Quit   Tab Navigate ",
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

  async start(): Promise<void> {
    await this.refresh();
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
    return this.box(parent, id, {
      border: true,
      borderStyle: "rounded",
      borderColor: color.line,
      title,
      titleColor: color.accent,
      backgroundColor: color.panel,
      paddingX: 1,
      ...options,
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
      selectable: false,
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
        if (event.button === 0) invoke();
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
    const narrow = this.renderer.width < 95;
    this.body.flexDirection = narrow ? "column" : "row";
    this.body.height = narrow ? 30 : Math.max(18, this.renderer.height - 18);
    this.treePanel.height = narrow ? 10 : "100%";
    this.detailPanel.height = narrow ? 19 : "100%";
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
    try {
      const snapshot = await this.manager.snapshot();
      if (this.disposed || this.modal || (this.busy && !force)) return;
      this.workspaces = snapshot.worktrees;
      if (!this.current) this.selected = this.workspaces[0]?.tree.path ?? "";
      this.renderTrees();
      await this.updateDetails();
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
            if (event.button === 0 && !this.modal) this.selectTree(ws.tree.path);
          },
        });
        const text = this.text(box, `tree-text:${ws.tree.path}`, "", { height: 2 });
        row = { box, text };
        this.treeRows.set(ws.tree.path, row);
      }
      const flags = `${ws.tree.dirty ? " *" : ""}${ws.tree.main ? " [main]" : ""}${ws.tree.locked ? " [locked]" : ""}${ws.tree.prunable ? " [missing]" : ""}`;
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
    this.detailPanel.title = ` ${ws.tree.branch} `;
    this.details.content = `${ws.tree.path}\n${ws.status}`;
    this.command.content = command || "No server command yet";
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
            if (event.button === 0 && !this.modal) {
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
    this.logPanel.title = ` SERVER OUTPUT / ${ws.tree.branch} `;
    if (logs !== this.logContent) {
      this.logText.content = stripVTControlCharacters(logs);
      if (!this.logContent) this.logPanel.scrollTo(999999);
      this.logContent = logs;
    }
  }

  private updateButtons(): void {
    const ws = this.current;
    for (const id of ["add", "refresh", "quit", "editor", "terminal"]) this.enable(id, !this.busy);
    this.enable("run", !this.busy && Boolean(ws && !ws.running && !ws.tree.prunable));
    this.enable("stop", !this.busy && Boolean(ws?.running));
    this.enable(
      "remove",
      !this.busy && Boolean(ws && !ws.tree.main && !ws.tree.locked && !ws.running),
    );
    this.enable("browser", !this.busy && Boolean(ws?.ports.length));
    this.enable("copy", !this.busy && Boolean(ws?.ports.length));
  }

  private onKey(key: KeyEvent): void {
    if (key.name === "tab") {
      key.preventDefault();
      const items = (this.modal?.focus ?? this.focus).filter(
        (item) => item.visible && (this.buttons.get(item.id)?.enabled ?? true),
      );
      const focused = this.renderer.currentFocusedRenderable;
      const index = focused ? items.indexOf(focused) : -1;
      items[(index + (key.shift ? -1 : 1) + items.length) % items.length]?.focus();
      return;
    }
    if (this.modal) {
      if (key.name === "escape") {
        key.preventDefault();
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

  private field(dialog: Dialog, id: string, label: string, value = "", placeholder = "") {
    this.text(dialog.panel, `${id}-label`, label, { height: 1, fg: color.muted });
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
    dialog.panel.add(input);
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
    for (const id of ["cancel", "submit", "existing"]) this.buttons.delete(id);
    this.treeList.focus();
  }

  openAdd(): void {
    if (this.busy || this.modal) return;
    const dialog = this.createDialog("add", "New worktree", 20);
    const branch = this.field(dialog, "branch", "Branch", "", "feature/login");
    const path = this.field(
      dialog,
      "path",
      "Directory · optional",
      "",
      "Default: sibling <repo>.worktrees/<branch>",
    );
    const base = this.field(dialog, "base", "Base ref · for a new branch", "HEAD");
    let existing = false;
    this.button(
      dialog.panel,
      "existing",
      "[ ] Use an existing branch",
      () => {
        existing = !existing;
        const toggle = this.buttons.get("existing");
        if (toggle) toggle.text.content = `${existing ? "[x]" : "[ ]"} Use an existing branch`;
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
        base: base.value.trim() || "HEAD",
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
      if (this.modal || this.busy || this.disposed) return;
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
