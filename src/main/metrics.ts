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
import {
  HostConfig,
  HostId,
  HostMetrics,
  MetricsPayload,
  buildFleetSummary,
  resolveHosts,
} from "@src/shared/hosts";

const execFileAsync = promisify(execFile);

const LINUX_CMD = [
  "CPU=$(grep '^cpu ' /proc/stat | awk '{u=$2+$4; t=$2+$3+$4+$5+$6+$7+$8; printf \"%s %s\", u, t}')",
  "sleep 0.35",
  "CPU2=$(grep '^cpu ' /proc/stat | awk '{u=$2+$4; t=$2+$3+$4+$5+$6+$7+$8; printf \"%s %s\", u, t}')",
  "MEM=$(awk '/MemTotal:/{t=$2} /MemAvailable:/{a=$2} END{if(t>0) printf \"%.1f\", (t-a)*100/t; else print \"0\"}' /proc/meminfo)",
  'echo "CPU $CPU $CPU2"',
  'echo "MEM $MEM"',
].join("; ");

const DARWIN_CMD = [
  "PAGE=$(pagesize)",
  "TOTAL=$(sysctl -n hw.memsize)",
  "USED=$(vm_stat | awk -v p=$PAGE '/Pages active/{a=$3} /Pages wired/{w=$4} /Pages occupied by compressor/{c=$5} END{gsub(/\\./,\"\",a);gsub(/\\./,\"\",w);gsub(/\\./,\"\",c); print (a+w+c)*p}')",
  "MEM=$(awk -v u=\"$USED\" -v t=\"$TOTAL\" 'BEGIN{ if(t>0) printf \"%.1f\", u*100/t; else print \"0\" }')",
  "LOAD=$(sysctl -n vm.loadavg | awk '{print $2}')",
  "NCPU=$(sysctl -n hw.ncpu)",
  "CPU=$(awk -v l=\"$LOAD\" -v n=\"$NCPU\" 'BEGIN{ if(n>0){v=l*100/n; if(v>100)v=100; printf \"%.1f\", v} else print \"0\" }')",
  DARWIN_GPU_SNIPPET,
  'echo "CPU $CPU"',
  'echo "MEM $MEM"',
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
  'awk -v u="$USED" -v t="$TOTAL" \'BEGIN{ if(t>0) printf "%.1f", u*100/t; else print "0" }\'',
].join("; ");

type CpuSnap = { idle: number; total: number };
type SampleParts = { cpu: number; mem: number; gpu: number | null };

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

function parseLinux(stdout: string): SampleParts {
  const cpuLine = stdout.match(/CPU\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
  const memLine = stdout.match(/MEM\s+([0-9.]+)/);
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
  const mem = memLine ? Number(memLine[1]) : 0;
  return {
    cpu: clampPercent(cpu),
    mem: clampPercent(mem),
    gpu: parseGpuLine(stdout),
  };
}

function parseDarwin(stdout: string): SampleParts {
  const cpuLine = stdout.match(/CPU\s+([0-9.]+)/);
  const memLine = stdout.match(/MEM\s+([0-9.]+)/);
  return {
    cpu: clampPercent(cpuLine ? Number(cpuLine[1]) : 0),
    mem: clampPercent(memLine ? Number(memLine[1]) : 0),
    gpu: parseGpuLine(stdout),
  };
}

function sshEnv(host: HostConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (host.sshHost) env.SSH_HOST = host.sshHost;
  if (host.sshPort) env.SSH_PORT = String(host.sshPort);
  return env;
}

function tcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
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

/* .local can be slow once; give mDNS a bit more room than plain LAN IPs */
async function hostReachable(host: HostConfig): Promise<boolean> {
  if (!host.sshHost) return false;
  const port = host.sshPort || 22;
  const timeoutMs = host.sshHost.endsWith(".local") ? 3500 : 1500;
  return tcpOpen(host.sshHost, port, timeoutMs);
}

async function ensureMux(host: HostConfig): Promise<void> {
  if (!host.sshScript) return;
  try {
    await execFileAsync(host.sshScript, ["--up"], {
      timeout: 25000,
      maxBuffer: 1024 * 64,
      env: sshEnv(host),
    });
  } catch {
    /* sample will surface the real error */
  }
}

async function runRemoteSample(host: HostConfig): Promise<SampleParts> {
  if (!host.sshScript) throw new Error("missing ssh script");
  const env = sshEnv(host);
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
    let memPercent: number;
    let gpuPercent: number | null = null;
    if (process.platform === "darwin") {
      const [{ stdout }, gpu] = await Promise.all([
        execFileAsync("/bin/bash", ["-lc", LOCAL_DARWIN_MEM_CMD], {
          timeout: 5000,
          maxBuffer: 1024 * 64,
        }),
        sampleLocalDarwinGpu(),
      ]);
      memPercent = clampPercent(Number(stdout.trim()));
      gpuPercent = gpu;
    } else {
      const total = os.totalmem();
      memPercent = clampPercent(total > 0 ? ((total - os.freemem()) * 100) / total : 0);
    }
    const metrics = toMetrics(
      host,
      { cpu: cpuPercent ?? 0, mem: memPercent, gpu: gpuPercent },
      true,
      updatedAt,
    );
    if (cpuPercent == null) metrics.cpuPercent = null;
    lastGood.set(host.id, metrics);
    return metrics;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: host.id,
      label: host.label,
      cpuPercent: null,
      memPercent: null,
      gpuPercent: null,
      availPercent: 0,
      online: false,
      error: message.slice(0, 160),
      updatedAt,
    };
  }
}

async function sampleRemote(host: HostConfig): Promise<HostMetrics> {
  const updatedAt = Date.now();
  const reachable = await hostReachable(host);

  if (!reachable) {
    return {
      id: host.id,
      label: host.label,
      cpuPercent: null,
      memPercent: null,
      gpuPercent: null,
      availPercent: 0,
      online: false,
      error: "host not reachable on ssh port",
      updatedAt,
    };
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
      return {
        id: host.id,
        label: host.label,
        cpuPercent: null,
        memPercent: null,
        gpuPercent: null,
        availPercent: 100,
        online: true,
        error: message.slice(0, 160),
        updatedAt,
      };
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
