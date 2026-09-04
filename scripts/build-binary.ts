import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

if (!["darwin", "linux"].includes(process.platform)) {
  throw new Error("Binary builds currently support macOS and Linux.");
}

const project = resolve(import.meta.dir, "..");
const output = join(project, "dist", "wt");
const temporary = `${output}.${process.pid}.tmp`;
await mkdir(join(project, "dist"), { recursive: true });
const start = performance.now();

try {
  const result = await Bun.build({
    entrypoints: [join(project, "src", "standalone.ts")],
    target: "bun",
    compile: { outfile: temporary, autoloadDotenv: false, autoloadBunfig: false },
    minify: true,
    define: {
      WT_STANDALONE: "true",
      "process.env.OPENTUI_LIBC": JSON.stringify(process.env.OPENTUI_LIBC || "glibc"),
    },
  });
  if (!result.success) throw new AggregateError(result.logs, "Binary build failed.");
  // Replace the previous build only after a successful compile. A running old
  // binary (including detached supervisors) keeps its existing executable image.
  await rename(temporary, output);
  const bytes = (await stat(output)).size;
  console.log(`Built ${output}`);
  console.log(
    `${process.platform}-${process.arch} · ${(bytes / 1024 / 1024).toFixed(1)} MiB · ${((performance.now() - start) / 1000).toFixed(1)}s`,
  );
  console.log("Run: ./dist/wt  (or ./dist/wt -C /path/to/repo)");
} finally {
  await rm(temporary, { force: true });
}
