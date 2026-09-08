import {
  type BoxRenderable,
  type CliRenderer,
  type OptimizedBuffer,
  TextRenderable,
} from "@opentui/core";
import { color } from "./theme.ts";

// Draw over the label without intercepting its hover, selection, or click events.
class TooltipText extends TextRenderable {
  override render(buffer: OptimizedBuffer): void {
    if (!this.visible) return;
    this.markClean();
    const left = Math.max(0, this.x - 1);
    const right = Math.min(buffer.width, this.x + this.width + 1);
    buffer.fillRect(left, this.y, right - left, this.height, this.bg);
    this.renderSelf(buffer);
  }
}

export class ProjectTooltip {
  private readonly text: TextRenderable;

  constructor(
    private readonly renderer: CliRenderer,
    parent: BoxRenderable,
    private readonly suppressed: () => boolean,
  ) {
    this.text = new TooltipText(renderer, {
      id: "project-tooltip",
      content: "",
      position: "absolute",
      zIndex: 95,
      visible: false,
      selectable: false,
      bg: color.tooltip,
      fg: color.tooltipText,
      wrapMode: "char",
    });
    parent.add(this.text);
  }

  hide(): void {
    this.text.visible = false;
  }

  attach(text: TextRenderable, content = () => text.plainText.trim()): void {
    const show = () => {
      if (this.suppressed() || Bun.stringWidth(text.plainText) <= text.width) {
        this.text.visible = false;
        return;
      }
      const value = content();
      const fullWidth = Bun.stringWidth(value);
      const left = Math.max(0, Math.min(text.x, this.renderer.width - 1));
      const width = Math.min(fullWidth, Math.max(1, this.renderer.width - left - 1));
      this.text.content = value;
      this.text.width = width;
      this.text.left = left;
      const height = Math.ceil(fullWidth / Math.max(1, width));
      this.text.top = Math.max(0, Math.min(text.y, this.renderer.height - height));
      this.text.visible = true;
    };
    text.onMouseOver = show;
    text.onMouseMove = show;
    text.onMouseOut = () => {
      this.text.visible = false;
    };
    text.onMouseDown = () => {
      this.text.visible = false;
    };
  }
}
