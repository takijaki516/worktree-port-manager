import { type OptimizedBuffer, TextRenderable } from "@opentui/core";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class EndTruncatedText extends TextRenderable {
  protected override renderSelf(buffer: OptimizedBuffer): void {
    // OpenTUI's built-in truncation removes the middle. Keep the original buffer
    // for selection and tooltips, and paint an ellipsis over the clipped tail.
    this.textBufferView.setTruncate(false);
    super.renderSelf(buffer);
    if (!this.truncate || this.wrapMode !== "none" || this.width < 1) return;

    const lines = this.plainText.split("\n").slice(this.scrollY, this.scrollY + this.height);
    for (const [row, line] of lines.entries()) {
      if (Bun.stringWidth(line) <= this.width) continue;
      let columns = 0;
      for (const { segment } of graphemes.segment(line)) {
        const width = Bun.stringWidth(segment);
        if (columns + width > this.width - 1) break;
        columns += width;
      }
      buffer.drawText(
        `${" ".repeat(this.width - columns - 1)}…`,
        this.x + columns,
        this.y + row,
        this.fg,
        this.bg,
      );
    }
  }
}
