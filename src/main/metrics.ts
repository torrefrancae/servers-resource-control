import { execFile } from "node:child_process";
import net from "node:net";
import os from "node:os";
import { promisify } from "node:util";
import {
  DARWIN_GPU_SNIPPET,
  parseGpuLine,
  sampleLinuxGpu,
  sampleLocalDarwinGpu,
} from "@src/main/gpu";
import { sshProcessEnv } from "@src/main/host-env";
import {
  HostConfig,
  HostId,
  HostMetrics,
  MetricsPayload,
  buildFleetSummary,
  resolveHosts,
} from "@src/shared/hosts";

const execFileAsync = promisify(execFile);

/*
 * Disk used% + 1K-block used/total.
 * On macOS APFS, df / is the sealed system snapshot (tiny "Used");
 * /System/Volumes/Data tracks real user storage in the container.
 */
const DISK_CMD = [
  'DISK_SRC=/',
  'if [ -d /System/Volumes/Data ]; then DISK_SRC=/System/Volumes/Data; fi',
  'DISK=$(df -Pk "$DISK_SRC" | awk \'NR==2 {gsub(/%/,"",$5); printf "%s %s %s", $5, $3, $2}\')',
  'echo "DISK $DISK"',
].join("; ");

const LINUX_CMD = [
  "CPU=$(grep '^cpu ' /proc/stat | awk '{u=$2+$4; t=$2+$3+$4+$5+$6+$7+$8; printf \"%s %s\", u, t}')",
  "sleep 0.35",
  "CPU2=$(grep '^cpu ' /proc/stat | awk '{u=$2+$4; t=$2+$3+$4+$5+$6+$7+$8; printf \"%s %s\", u, t}')",
  "MEM=$(awk '/MemTotal:/{t=$2} /MemAvailable:/{a=$2} END{u=t-a; if(t>0) printf \"%.1f %d %d\", (u*100)/t, u, t; else print \"0 0 0\"}' /proc/meminfo)",
  "LOAD=$(awk '{print $1}' /proc/loadavg)",
  "NCPU=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)",
  "FREQ_KHZ=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null || echo 0)",
  "FREQ=$((FREQ_KHZ * 1000))",
  DISK_CMD,
  'echo "CPU $CPU $CPU2"',
  'echo "MEM $MEM"',
  'echo "LOAD $LOAD"',
  'echo "NCPU $NCPU"',
  'echo "FREQ $FREQ"',
].join("; ");

const DARWIN_CMD = [
  "PAGE=$(pagesize)",
  "TOTAL=$(sysctl -n hw.memsize)",
  "USED=$(vm_stat | awk -v p=$PAGE '/Pages active/{a=$3} /Pages wired/{w=$4} /Pages occupied by compressor/{c=$5} END{gsub(/\\./,\"\",a);gsub(/\\./,\"\",w);gsub(/\\./,\"\",c); print (a+w+c)*p}')",
  "MEM=$(awk -v u=\"$USED\" -v t=\"$TOTAL\" 'BEGIN{ if(t>0) printf \"%.1f %s %s\", u*100/t, u, t; else print \"0 0 0\" }')",
  "LOAD=$(sysctl -n vm.loadavg | awk '{print $2}')",
  "NCPU=$(sysctl -n hw.ncpu)",
  "FREQ=$(sysctl -n hw.cpufrequency 2>/dev/null || sysctl -n hw.cpufrequency_max 2>/dev/null || echo 0)",
  "CPU=$(awk -v l=\"$LOAD\" -v n=\"$NCPU\" 'BEGIN{ if(n>0){v=l*100/n; if(v>100)v=100; printf \"%.1f\", v} else print \"0\" }')",
  DARWIN_GPU_SNIPPET,
  DISK_CMD,
  'echo "CPU $CPU"',
  'echo "MEM $MEM"',
  'echo "LOAD $LOAD"',
  'echo "NCPU $NCPU"',
  'echo "FREQ $FREQ"',
].join("; ");

const LOCAL_DARWIN_MEM_CMD = [
  "TOTAL=$(sysctl -n hw.memsize)",
  "PAGE=$(pagesize)",
  "USED=$(vm_stat | awk -v p=$PAGE '",
  "/Pages active/ {a=$3}",
  "/Pages wired/ {w=$4}",
  "/Pages occupied by compressor/ {c=$5}",
  "END {",
  "  gsub(/\\./,\"\",a); gsub(/\\./,\"\",w); gsub(/\\./,\"\",c);",
  "  print (a+w+c)*p",
  "}')",
  'awk -v u="$USED" -v t="$TOTAL" \'BEGIN{ if(t>0) printf "%.1f %s %s", u*100/t, u, t; else print "0 0 0" }\'',
].join("; ");

type CpuSnap = { idle: number; total: number };
type DiskParts = {
  disk: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
};
type MemParts = {
  mem: number;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
};
type CpuExtra = {
  cpuLoad: number | null;
  cpuFreqHz: number | null;
  cpuCores: number | null;
};
type SampleParts = {
  cpu: number;
  gpu: number | null;
} & DiskParts &
  MemParts &
  CpuExtra;

const lastGood = new Map<HostId, HostMetrics>();
let localCpuSnap: CpuSnap | null = null;

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function readCpuSnap(): CpuSnap {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.idle +
      cpu.times.irq;
  }
  return { idle, total };
}

function sampleLocalCpuPercent(): number | null {
  const now = readCpuSnap();
  if (!localCpuSnap) {
    localCpuSnap = now;
    return null;
  }
  const di = now.idle - localCpuSnap.idle;
  const dt = now.total - localCpuSnap.total;
  localCpuSnap = now;
  if (dt <= 0) return 0;
  return clampPercent((1 - di / dt) * 100);
}

function parseDisk(stdout: string): DiskParts {
  const diskLine = stdout.match(/DISK\s+([0-9.]+)\s+(\d+)\s+(\d+)/);
  if (!diskLine) {
    return { disk: null, diskUsedBytes: null, diskTotalBytes: null };
  }
  const usedKiB = Number(diskLine[2]);
  const totalKiB = Number(diskLine[3]);
  return {
    disk: clampPercent(Number(diskLine[1])),
    diskUsedBytes: Number.isFinite(usedKiB) ? usedKiB * 1024 : null,
    diskTotalBytes: Number.isFinite(totalKiB) ? totalKiB * 1024 : null,
  };
}

function parseMem(stdout: string, unit: "kib" | "bytes"): MemParts {
  const memLine = stdout.match(/MEM\s+([0-9.]+)(?:\s+(\d+)\s+(\d+))?/);
  if (!memLine) {
    return { mem: 0, memUsedBytes: null, memTotalBytes: null };
  }
  const scale = unit === "kib" ? 1024 : 1;
  const used = memLine[2] != null ? Number(memLine[2]) * scale : null;
  const total = memLine[3] != null ? Number(memLine[3]) * scale : null;
  return {
    mem: clampPercent(Number(memLine[1])),
    memUsedBytes: used != null && Number.isFinite(used) ? used : null,
    memTotalBytes: total != null && Number.isFinite(total) ? total : null,
  };
}

function parseCpuExtra(stdout: string): CpuExtra {
  const loadLine = stdout.match(/LOAD\s+([0-9.]+)/);
  const ncpuLine = stdout.match(/NCPU\s+(\d+)/);
  const freqLine = stdout.match(/FREQ\s+(\d+)/);
  const load = loadLine ? Number(loadLine[1]) : null;
  const cores = ncpuLine ? Number(ncpuLine[1]) : null;
  const freq = freqLine ? Number(freqLine[1]) : null;
  return {
    cpuLoad: load != null && Number.isFinite(load) ? load : null,
    cpuCores: cores != null && Number.isFinite(cores) && cores > 0 ? cores : null,
    cpuFreqHz: freq != null && Number.isFinite(freq) && freq > 0 ? freq : null,
  };
}

function parseLinux(stdout: string): SampleParts {
  const cpuLine = stdout.match(/CPU\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
  let cpu = 0;
  if (cpuLine) {
    const u1 = Number(cpuLine[1]);
    const t1 = Number(cpuLine[2]);
    const u2 = Number(cpuLine[3]);
    const t2 = Number(cpuLine[4]);
    const du = u2 - u1;
    const dt = t2 - t1;
    cpu = dt > 0 ? (du / dt) * 100 : 0;
  }
  return {
    cpu: clampPercent(cpu),
    gpu: parseGpuLine(stdout),
    ...parseMem(stdout, "kib"),
    ...parseDisk(stdout),
    ...parseCpuExtra(stdout),
  };
}

function parseDarwin(stdout: string): SampleParts {
  const cpuLine = stdout.match(/CPU\s+([0-9.]+)/);
  return {
    cpu: clampPercent(cpuLine ? Number(cpuLine[1]) : 0),
    gpu: parseGpuLine(stdout),
    ...parseMem(stdout, "bytes"),
    ...parseDisk(stdout),
    ...parseCpuExtra(stdout),
  };
}

function localCpuExtras(): CpuExtra {
  const load = os.loadavg()[0];
  const cores = os.cpus().length;
  const speeds = os
    .cpus()
    .map((c) => c.speed)
    .filter((n) => Number.isFinite(n) && n > 0);
  const mhz = speeds.length
    ? speeds.reduce((a, b) => a + b, 0) / speeds.length
    : 0;
  return {
    cpuLoad: Number.isFinite(load) ? load : null,
    cpuCores: cores > 0 ? cores : null,
    /* os.cpus().speed is MHz on most platforms */
    cpuFreqHz: mhz > 0 ? mhz * 1_000_000 : null,
  };
}

async function sampleLocalDisk(): Promise<DiskParts> {
  try {
    const { stdout } = await execFileAsync("/bin/bash", ["-lc", DISK_CMD], {
      timeout: 5000,
      maxBuffer: 1024 * 16,
    });
    return parseDisk(stdout);
  } catch {
    return { disk: null, diskUsedBytes: null, diskTotalBytes: null };
  }
}

function tcpOpen(
  host: string,
  port: number,
  timeoutMs: number,
  family?: 4 | 6,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(
      family ? { host, port, family } : { host, port },
    );
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/* Prefer IPv4 for .local - AAAA link-local often fails without a zone id. */
async function hostReachable(host: HostConfig): Promise<boolean> {
  if (!host.sshHost) return false;
  const port = host.sshPort || 22;
  const timeoutMs = host.sshHost.endsWith(".local") ? 3500 : 1500;
  if (await tcpOpen(host.sshHost, port, timeoutMs, 4)) return true;
  return tcpOpen(host.sshHost, port, timeoutMs);
}

async function ensureMux(host: HostConfig): Promise<void> {
  if (!host.sshScript) return;
  try {
    await execFileAsync(host.sshScript, ["--up"], {
      timeout: 25000,
      maxBuffer: 1024 * 64,
      env: sshProcessEnv(host),
    });
  } catch {
    /* sample will surface the real error */
  }
}

async function runRemoteSample(host: HostConfig): Promise<SampleParts> {
  if (!host.sshScript) throw new Error("missing ssh script");
  const env = sshProcessEnv(host);
  if (host.kind === "linux") {
    const [{ stdout, stderr }, gpu] = await Promise.all([
      execFileAsync(host.sshScript, [LINUX_CMD], {
        timeout: 25000,
        maxBuffer: 1024 * 256,
        env,
      }),
      sampleLinuxGpu(host, env),
    ]);
    const parsed = parseLinux(`${stdout}\n${stderr}`);
    return { ...parsed, gpu: gpu ?? parsed.gpu };
  }

  const { stdout, stderr } = await execFileAsync(host.sshScript, [DARWIN_CMD], {
    timeout: 25000,
    maxBuffer: 1024 * 256,
    env,
  });
  return parseDarwin(`${stdout}\n${stderr}`);
}

function emptyMetrics(
  host: HostConfig,
  online: boolean,
  updatedAt: number,
  error?: string,
): HostMetrics {
  return {
    id: host.id,
    label: host.label,
    cpuPercent: null,
    memPercent: null,
    gpuPercent: null,
    diskPercent: null,
    diskUsedBytes: null,
    diskTotalBytes: null,
    memUsedBytes: null,
    memTotalBytes: null,
    cpuLoad: null,
    cpuFreqHz: null,
    cpuCores: null,
    availPercent: online ? 100 : 0,
    online,
    error,
    updatedAt,
  };
}

function toMetrics(
  host: HostConfig,
  parts: SampleParts,
  online: boolean,
  updatedAt: number,
  error?: string,
): HostMetrics {
  return {
    id: host.id,
    label: host.label,
    cpuPercent: parts.cpu,
    memPercent: parts.mem,
    gpuPercent: parts.gpu,
    diskPercent: parts.disk,
    diskUsedBytes: parts.diskUsedBytes,
    diskTotalBytes: parts.diskTotalBytes,
    memUsedBytes: parts.memUsedBytes,
    memTotalBytes: parts.memTotalBytes,
    cpuLoad: parts.cpuLoad,
    cpuFreqHz: parts.cpuFreqHz,
    cpuCores: parts.cpuCores,
    availPercent: online ? 100 : 0,
    online,
    error,
    updatedAt,
  };
}

async function sampleLocal(host: HostConfig): Promise<HostMetrics> {
  const updatedAt = Date.now();
  try {
    const cpuPercent = sampleLocalCpuPercent();
    let mem: MemParts = {
      mem: 0,
      memUsedBytes: null,
      memTotalBytes: null,
    };
    let gpuPercent: number | null = null;
    let disk: DiskParts = {
      disk: null,
      diskUsedBytes: null,
      diskTotalBytes: null,
    };
    if (process.platform === "darwin") {
      const [{ stdout }, gpu, diskSample] = await Promise.all([
        execFileAsync("/bin/bash", ["-lc", LOCAL_DARWIN_MEM_CMD], {
          timeout: 5000,
          maxBuffer: 1024 * 64,
        }),
        sampleLocalDarwinGpu(),
        sampleLocalDisk(),
      ]);
      mem = parseMem(`MEM ${stdout.trim()}`, "bytes");
      gpuPercent = gpu;
      disk = diskSample;
    } else {
      const total = os.totalmem();
      const free = os.freemem();
      const used = Math.max(0, total - free);
      mem = {
        mem: clampPercent(total > 0 ? (used * 100) / total : 0),
        memUsedBytes: used,
        memTotalBytes: total,
      };
      disk = await sampleLocalDisk();
    }
    const metrics = toMetrics(
      host,
      {
        cpu: cpuPercent ?? 0,
        gpu: gpuPercent,
        ...mem,
        ...disk,
        ...localCpuExtras(),
      },
      true,
      updatedAt,
    );
    if (cpuPercent == null) metrics.cpuPercent = null;
    lastGood.set(host.id, metrics);
    return metrics;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return emptyMetrics(host, false, updatedAt, message.slice(0, 160));
  }
}

async function sampleRemote(host: HostConfig): Promise<HostMetrics> {
  const updatedAt = Date.now();
  const reachable = await hostReachable(host);

  if (!reachable) {
    return emptyMetrics(host, false, updatedAt, "host not reachable on ssh port");
  }

  try {
    const parsed = await runRemoteSample(host);
    const metrics = toMetrics(host, parsed, true, updatedAt);
    lastGood.set(host.id, metrics);
    return metrics;
  } catch {
    await ensureMux(host);
    try {
      const parsed = await runRemoteSample(host);
      const metrics = toMetrics(host, parsed, true, Date.now());
      lastGood.set(host.id, metrics);
      return metrics;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const prev = lastGood.get(host.id);
      if (prev && Date.now() - prev.updatedAt < 120000) {
        return {
          ...prev,
          online: true,
          error: message.slice(0, 120),
          updatedAt,
        };
      }
      return emptyMetrics(host, true, updatedAt, message.slice(0, 160));
    }
  }
}

async function sampleHost(host: HostConfig): Promise<HostMetrics> {
  if (host.source === "local") return sampleLocal(host);
  return sampleRemote(host);
}

export async function pollAll(): Promise<MetricsPayload> {
  const hosts = resolveHosts();
  const results = await Promise.all(hosts.map((h) => sampleHost(h)));
  const polledAt = Date.now();
  return {
    hosts: [...results, buildFleetSummary(results, polledAt)],
    polledAt,
  };
}
