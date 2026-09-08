import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { EndTruncatedText } from "../src/end-truncated-text.ts";

test("truncates each line on the right and preserves the full source on resize", async () => {
  const terminal = await createTestRenderer({ width: 24, height: 4 });
  try {
    const text = new EndTruncatedText(terminal.renderer, {
      id: "text",
      content: "abcdefghijk\n가나다라마\ne\u0301abcdefghi",
      width: 6,
      height: 3,
      wrapMode: "none",
      truncate: true,
    });
    terminal.renderer.root.add(text);
    await terminal.renderOnce();
    expect(
      terminal
        .captureCharFrame()
        .split("\n")
        .slice(0, 3)
        .map((line) => line.trimEnd()),
    ).toEqual(["abcde…", "가나 …", "e\u0301abcd…"]);
    expect(text.plainText).toBe("abcdefghijk\n가나다라마\ne\u0301abcdefghi");
    text.width = 16;
    await terminal.renderOnce();
    expect(terminal.captureCharFrame()).toContain("abcdefghijk");
    expect(terminal.captureCharFrame()).not.toContain("…");
    text.width = 1;
    await terminal.renderOnce();
    expect(terminal.captureCharFrame().split("\n")[0]?.trimEnd()).toBe("…");
  } finally {
    terminal.renderer.destroy();
  }
});
