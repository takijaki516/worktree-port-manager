import { dirname } from "node:path";
import { execute } from "./system.ts";
import type { Port, RunRecord } from "./types.ts";

export interface ProcessInfo {
  pid: number;
  parent: number;
  group: number;
  started: string;
  status: string;
}

export async function processTable(): Promise<Map<number, ProcessInfo>> {
  const { stdout, code } = await execute("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,stat="], 6000);
  if (code !== 0) throw new Error("Cannot read the process table.");
  const table = new Map<number, ProcessInfo>();
  for (const line of stdout.split("\n")) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(\S+)/,
    );
    if (match)
      table.set(Number(match[1]), {
        pid: Number(match[1]),
        parent: Number(match[2]),
        group: Number(match[3]),
        started: (match[4] ?? "").replace(/\s+/g, " "),
        status: match[5] ?? "",
      });
  }
  return table;
}

export function isLive(record: RunRecord | undefined, table: Map<number, ProcessInfo>): boolean {
  if (!record) return false;
  const info = table.get(record.pid);
  if (!info || info.status.startsWith("Z")) return false;
  if (record.started_at) return record.started_at === info.started;
  return (
    typeof record.created_at === "number" &&
    Math.abs(Date.parse(info.started) / 1000 - record.created_at) < 1.5
  );
}

export async function legacyIdentityMatches(record: RunRecord): Promise<boolean> {
  const result = await execute("ps", ["-p", String(record.pid), "-o", "command="], 3000);
  return (
    result.code === 0 &&
    result.stdout.includes("worktree_manager.supervisor") &&
    result.stdout.includes(dirname(record.result))
  );
}

export function descendants(pid: number, table: Map<number, ProcessInfo>): Set<number> {
  const result = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const info of table.values()) {
      if (result.has(info.parent) && !result.has(info.pid)) {
        result.add(info.pid);
        changed = true;
      }
    }
  }
  return result;
}

export function parseListeners(raw: string): Port[] {
  const result = new Map<string, Port>();
  let pid = 0;
  let name = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      name = "";
    } else if (line.startsWith("c")) name = line.slice(1);
    else if (line.startsWith("n") && pid) {
      const colon = line.lastIndexOf(":");
      const port = Number(line.slice(colon + 1));
      if (colon > 0 && Number.isInteger(port) && port > 0) {
        result.set(`${pid}:${port}`, {
          pid,
          name,
          host: line.slice(1, colon),
          port,
          managed: false,
        });
      }
    }
  }
  return [...result.values()].sort((a, b) => a.port - b.port || a.pid - b.pid);
}

export async function listeners(): Promise<{ ports: Port[]; warning: string }> {
  const binary = Bun.which("lsof") || (process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof");
  try {
    const result = await execute(binary, ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], 6000);
    if (![0, 1].includes(result.code)) throw new Error(result.stderr);
    return { ports: parseListeners(result.stdout), warning: "" };
  } catch (error) {
    return { ports: [], warning: `Port discovery unavailable (lsof): ${error}` };
  }
}

export async function workingDirectories(pids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (!pids.length) return result;
  const binary = Bun.which("lsof") || (process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof");
  const { stdout } = await execute(
    binary,
    ["-a", "-p", [...new Set(pids)].join(","), "-d", "cwd", "-Fn"],
    6000,
  );
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) result.set(pid, line.slice(1));
  }
  return result;
}

export function portUrl(port: Port): string {
  let host = port.host.replace(/^\[|\]$/g, "");
  if (["*", "0.0.0.0", "::", "::1", "127.0.0.1"].includes(host)) host = "localhost";
  else if (host.includes(":")) host = `[${host}]`;
  return `http://${host}:${port.port}`;
}
