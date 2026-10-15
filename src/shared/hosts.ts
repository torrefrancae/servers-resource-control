import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type HostId = string;

export type HostConfig = {
  id: Exclude<HostId, "fleet">;
  label: string;
  kind: "linux" | "darwin";
  source: "local" | "ssh";
  sshScript?: string;
  sshHost?: string;
  sshPort?: number;
};

export type HostMetrics = {
  id: HostId;
  label: string;
  cpuPercent: number | null;
  memPercent: number | null;
  gpuPercent: number | null;
  availPercent: number | null;
  online: boolean;
  onlineCount?: number;
  hostCount?: number;
  synthetic?: boolean;
  error?: string;
  updatedAt: number;
};

export type MetricsPayload = {
  hosts: HostMetrics[];
  polledAt: number;
};

export const POLL_MS = 2500;

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function configCandidates(): string[] {
  const root = path.resolve(__dirname, "..", "..");
  return [
    path.join(root, "config", "hosts.json"),
    path.join(root, "config", "hosts.example.json"),
  ];
}

function defaultLocalHost(): HostConfig[] {
  return [
    {
      id: "local",
      label: os.hostname() || "local",
      kind: process.platform === "darwin" ? "darwin" : "linux",
      source: "local",
    },
  ];
}

function normalizeHost(raw: HostConfig, home: string): HostConfig | null {
  if (!raw || typeof raw.id !== "string" || !raw.id || raw.id === "fleet") {
    return null;
  }
  if (raw.source !== "local" && raw.source !== "ssh") return null;
  if (raw.kind !== "linux" && raw.kind !== "darwin") return null;
  const host: HostConfig = {
    id: raw.id,
    label: raw.label || raw.id,
    kind: raw.kind,
    source: raw.source,
  };
  if (raw.source === "ssh") {
    if (!raw.sshScript || !raw.sshHost) return null;
    host.sshScript = expandHome(String(raw.sshScript), home);
    host.sshHost = String(raw.sshHost);
    host.sshPort = Number(raw.sshPort) > 0 ? Number(raw.sshPort) : 22;
  }
  return host;
}

export function resolveHosts(home: string = os.homedir()): HostConfig[] {
  for (const file of configCandidates()) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as HostConfig[];
      if (!Array.isArray(parsed)) continue;
      const hosts = parsed
        .map((entry) => normalizeHost(entry, home))
        .filter((entry): entry is HostConfig => entry != null);
      if (hosts.length) return hosts;
    } catch {
      /* try next candidate */
    }
  }
  return defaultLocalHost();
}

function avg(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function buildFleetSummary(
  hosts: HostMetrics[],
  updatedAt: number,
): HostMetrics {
  const real = hosts.filter((h) => !h.synthetic);
  const onlineHosts = real.filter((h) => h.online);
  const hostCount = real.length;
  const onlineCount = onlineHosts.length;
  const availPercent = hostCount > 0 ? (onlineCount / hostCount) * 100 : 0;

  return {
    id: "fleet",
    label: "fleet",
    synthetic: true,
    online: onlineCount > 0,
    onlineCount,
    hostCount,
    availPercent,
    cpuPercent: avg(
      onlineHosts
        .map((h) => h.cpuPercent)
        .filter((n): n is number => n != null),
    ),
    memPercent: avg(
      onlineHosts
        .map((h) => h.memPercent)
        .filter((n): n is number => n != null),
    ),
    gpuPercent: avg(
      onlineHosts
        .map((h) => h.gpuPercent)
        .filter((n): n is number => n != null),
    ),
    updatedAt,
  };
}
