import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type HostId = string;

export type HostConfig = {
  id: Exclude<HostId, "fleet">;
  label: string;
  kind: "linux" | "darwin";
  source: "local" | "ssh";
  enabled?: boolean;
  sshScript?: string;
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshPassword?: string;
};

export type HostMetrics = {
  id: HostId;
  label: string;
  cpuPercent: number | null;
  memPercent: number | null;
  gpuPercent: number | null;
  diskPercent: number | null;
  diskUsedBytes?: number | null;
  diskTotalBytes?: number | null;
  memUsedBytes?: number | null;
  memTotalBytes?: number | null;
  cpuLoad?: number | null;
  cpuFreqHz?: number | null;
  cpuCores?: number | null;
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

export type ResolveHostsOptions = {
  includeDisabled?: boolean;
};

export const POLL_MS = 2500;

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

export function hostsConfigPath(): string {
  return path.join(path.resolve(__dirname, "..", ".."), "config", "hosts.json");
}

function configCandidates(): string[] {
  return [hostsConfigPath(), path.join(path.dirname(hostsConfigPath()), "hosts.example.json")];
}

function defaultLocalHost(): HostConfig[] {
  return [
    {
      id: "local",
      label: os.hostname() || "local",
      kind: process.platform === "darwin" ? "darwin" : "linux",
      source: "local",
      enabled: true,
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
    enabled: raw.enabled !== false,
  };
  if (typeof raw.sshUser === "string" && raw.sshUser.trim()) {
    host.sshUser = raw.sshUser.trim();
  }
  if (typeof raw.sshPassword === "string" && raw.sshPassword.length > 0) {
    host.sshPassword = raw.sshPassword;
  }
  if (raw.source === "ssh") {
    if (!raw.sshScript || !raw.sshHost) return null;
    host.sshScript = expandHome(String(raw.sshScript), home);
    host.sshHost = String(raw.sshHost);
    host.sshPort = Number(raw.sshPort) > 0 ? Number(raw.sshPort) : 22;
  }
  return host;
}

export function resolveHosts(
  home: string = os.homedir(),
  options: ResolveHostsOptions = {},
): HostConfig[] {
  for (const file of configCandidates()) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as HostConfig[];
      if (!Array.isArray(parsed)) continue;
      let hosts = parsed
        .map((entry) => normalizeHost(entry, home))
        .filter((entry): entry is HostConfig => entry != null);
      if (!options.includeDisabled) {
        hosts = hosts.filter((h) => h.enabled !== false);
      }
      if (hosts.length) return hosts;
    } catch {
      /* try next candidate */
    }
  }
  return defaultLocalHost();
}

export function writeHostsConfig(hosts: HostConfig[]): void {
  const file = hostsConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const serializable = hosts.map((h) => {
    const row: Record<string, unknown> = {
      id: h.id,
      label: h.label,
      kind: h.kind,
      source: h.source,
      enabled: h.enabled !== false,
    };
    if (h.source === "ssh") {
      row.sshScript = h.sshScript;
      row.sshHost = h.sshHost;
      row.sshPort = h.sshPort || 22;
      if (h.sshUser) row.sshUser = h.sshUser;
      if (h.sshPassword) row.sshPassword = h.sshPassword;
    } else if (h.sshUser) {
      row.sshUser = h.sshUser;
    }
    return row;
  });
  fs.writeFileSync(file, `${JSON.stringify(serializable, null, 2)}\n`, "utf8");
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
    diskPercent: avg(
      onlineHosts
        .map((h) => h.diskPercent)
        .filter((n): n is number => n != null),
    ),
    diskUsedBytes: sumOrNull(
      onlineHosts
        .map((h) => h.diskUsedBytes)
        .filter((n): n is number => n != null),
    ),
    diskTotalBytes: sumOrNull(
      onlineHosts
        .map((h) => h.diskTotalBytes)
        .filter((n): n is number => n != null),
    ),
    memUsedBytes: sumOrNull(
      onlineHosts
        .map((h) => h.memUsedBytes)
        .filter((n): n is number => n != null),
    ),
    memTotalBytes: sumOrNull(
      onlineHosts
        .map((h) => h.memTotalBytes)
        .filter((n): n is number => n != null),
    ),
    cpuLoad: avg(
      onlineHosts
        .map((h) => h.cpuLoad)
        .filter((n): n is number => n != null),
    ),
    cpuFreqHz: avg(
      onlineHosts
        .map((h) => h.cpuFreqHz)
        .filter((n): n is number => n != null),
    ),
    cpuCores: sumOrNull(
      onlineHosts
        .map((h) => h.cpuCores)
        .filter((n): n is number => n != null),
    ),
    updatedAt,
  };
}

function sumOrNull(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0);
}
