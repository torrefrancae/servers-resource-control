import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostConfig } from "@src/shared/hosts";
import {
  hostsConfigPath,
  resolveHosts,
  writeHostsConfig,
} from "@src/shared/hosts";
import {
  hydrateHostSecrets,
  writeEnvBesideScript,
} from "@src/main/host-env";

export type HostSettingsRow = {
  id: string;
  label: string;
  kind: "linux" | "darwin";
  source: "local" | "ssh";
  enabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshPassword: string;
  sshScript: string;
};

function projectRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `host-${Date.now()}`;
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  let n = 2;
  while (used.has(id) || id === "fleet") {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function wrapperScript(id: string): string {
  return path.join(projectRoot(), "config", "wrappers", id, "ssh.sh");
}

function ensureSshWrapper(id: string): string {
  const script = wrapperScript(id);
  if (fs.existsSync(script)) return script;
  fs.mkdirSync(path.dirname(script), { recursive: true });
  const body = `#!/usr/bin/env bash
set -euo pipefail
_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$_DIR/.env" ]]; then set -a; # shellcheck disable=SC1091
  . "$_DIR/.env"; set +a; fi
_SHMUX="\${SSH_MULTIPLEX_V2:-$HOME/proj/dev/sh/ssh-multiplex-v2.sh}"
[[ -x "$_SHMUX" ]] || _SHMUX="$HOME/projects/sh/ssh-multiplex-v2.sh"
_HOST="\${SSH_HOST:?missing SSH_HOST}"
_PORT="\${SSH_PORT:-22}"
if [[ -x "$_SHMUX" ]]; then
  exec "$_SHMUX" \\
    --ssh-user="\${SSH_USER:-$USER}" \\
    --ssh-host="$_HOST" \\
    --ssh-port="$_PORT" \\
    --dir="$_DIR" \\
    "$@"
fi
case "\${1:-}" in
  --up|--check|--down|--restart) exit 0 ;;
esac
exec ssh -p "$_PORT" "\${SSH_USER:-$USER}@$_HOST" "$@"
`;
  fs.writeFileSync(script, body, { mode: 0o755 });
  return script;
}

function toRow(host: HostConfig): HostSettingsRow {
  const hydrated = hydrateHostSecrets(host);
  return {
    id: hydrated.id,
    label: hydrated.label,
    kind: hydrated.kind,
    source: hydrated.source,
    enabled: hydrated.enabled !== false,
    sshHost: hydrated.sshHost || "",
    sshPort: hydrated.sshPort || 22,
    sshUser: hydrated.sshUser || "",
    sshPassword: hydrated.sshPassword || "",
    sshScript: hydrated.sshScript || "",
  };
}

export function listHostSettings(): HostSettingsRow[] {
  return resolveHosts(os.homedir(), { includeDisabled: true }).map(toRow);
}

export function saveHostSettings(rows: HostSettingsRow[]): HostSettingsRow[] {
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error("at least one host is required");
  }
  const used = new Set<string>();
  const next: HostConfig[] = [];

  for (const raw of rows) {
    const label = String(raw.label || "").trim();
    if (!label) throw new Error("each host needs a label");
    const source = raw.source === "local" ? "local" : "ssh";
    const kind = raw.kind === "linux" ? "linux" : "darwin";
    const id =
      source === "local"
        ? uniqueId(String(raw.id || "local").trim() || "local", used)
        : uniqueId(String(raw.id || "").trim() || slugify(label), used);

    if (source === "local") {
      next.push({
        id,
        label,
        kind,
        source: "local",
        enabled: raw.enabled !== false,
        sshUser: String(raw.sshUser || "").trim() || undefined,
      });
      continue;
    }

    const sshHost = String(raw.sshHost || "").trim();
    const sshUser = String(raw.sshUser || "").trim();
    const sshPassword = String(raw.sshPassword || "");
    const sshPort = Number(raw.sshPort) > 0 ? Number(raw.sshPort) : 22;
    if (!sshHost) throw new Error(`${label}: ssh host required`);
    if (!sshUser) throw new Error(`${label}: ssh user required`);

    let sshScript = String(raw.sshScript || "").trim();
    if (!sshScript) sshScript = ensureSshWrapper(id);
    else if (sshScript.startsWith("~/")) {
      sshScript = path.join(os.homedir(), sshScript.slice(2));
    }

    writeEnvBesideScript(sshScript, {
      sshUser,
      sshHost,
      sshPort,
      sshPassword,
    });

    next.push({
      id,
      label,
      kind,
      source: "ssh",
      enabled: raw.enabled !== false,
      sshScript,
      sshHost,
      sshPort,
      sshUser,
      sshPassword: sshPassword || undefined,
    });
  }

  if (!next.some((h) => h.source === "local")) {
    throw new Error("keep at least one local host");
  }

  writeHostsConfig(next);
  void hostsConfigPath();
  return listHostSettings();
}
