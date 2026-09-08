import {
  BoxRenderable,
  type CliRenderer,
  type Renderable,
  ScrollBoxRenderable,
  TextRenderable,
} from "@opentui/core";
import { EndTruncatedText } from "../end-truncated-text.ts";
import { color } from "./theme.ts";

export interface FocusScope {
  focus: Renderable[];
}

interface Button {
  box: BoxRenderable;
  text: TextRenderable;
  enabled: boolean;
  primary: boolean;
}

// Shared rendering, selection, and activation rules for the app and its forms.
export class Controls {
  readonly buttons = new Map<string, Button>();
  focus: Renderable[] = [];

  constructor(
    readonly renderer: CliRenderer,
    readonly canInvoke: (scope?: FocusScope) => boolean,
    readonly isMouseDrag: () => boolean,
  ) {}

  box(
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

  panel(
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
      paddingX: 0,
      ...options,
    });
    this.setPanelTitle(panel, title);
    return panel;
  }

  setPanelTitle(panel: BoxRenderable, title: string): void {
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

  text(
    parent: BoxRenderable,
    id: string,
    content: string,
    options: Partial<ConstructorParameters<typeof TextRenderable>[1]> = {},
  ) {
    const text = new EndTruncatedText(this.renderer, {
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

  button(
    parent: BoxRenderable,
    id: string,
    label: string,
    action: () => void,
    primary = false,
    width?: number,
    dialog?: FocusScope,
  ) {
    const invoke = () => {
      if (this.canInvoke(dialog) && this.buttons.get(id)?.enabled) action();
    };
    const box = this.box(parent, id, {
      height: 1,
      width: width ?? Math.max(...label.split("\n").map((line) => Array.from(line).length)) + 2,
      flexGrow: 0,
      minWidth: 4,
      border: false,
      paddingX: 1,
      backgroundColor: primary ? color.accent : color.raised,
      focusable: true,
      alignItems: "center",
      justifyContent: "center",
      onMouseUp: (event) => {
        if (event.button === 0 && !this.isMouseDrag()) invoke();
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
    box.on("focused", () => {
      box.backgroundColor = color.selected;
      text.fg = color.accent;
    });
    box.on("blurred", () => {
      box.backgroundColor = primary ? color.accent : color.raised;
      if (!text.isDestroyed) text.fg = primary ? color.bg : color.text;
    });
    (dialog?.focus ?? this.focus).push(box);
    return box;
  }

  enable(id: string, enabled: boolean): void {
    const button = this.buttons.get(id);
    if (!button) return;
    button.enabled = enabled;
    button.box.opacity = enabled ? 1 : 0.4;
  }
}
