import {
  clearSleepTimer,
  formatTargetLabel,
  getSleepTimerTarget,
  initSleepTimer,
  isSleepTimerActive,
  nextOccurrence,
  parseHhMm,
  setSleepTimer,
} from "./sleep-timer.js";

type HostMetrics = {
  id: string;
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
};

type MetricsPayload = {
  hosts: HostMetrics[];
  polledAt: number;
};

type SleepResult = {
  id: string;
  label: string;
  ok: boolean;
  error?: string;
};

type PcMonitorApi = {
  onMetrics: (cb: (payload: MetricsPayload) => void) => () => void;
  quit: () => void;
  restart: () => void;
  getAlwaysOnTop: () => Promise<boolean>;
  setAlwaysOnTop: (next: boolean) => Promise<boolean>;
  sleepHost: (id: string) => Promise<SleepResult>;
  sleepAll: () => Promise<SleepResult[]>;
};

declare global {
  interface Window {
    pcMonitor: PcMonitorApi;
  }
}

function levelClass(pct: number | null): string {
  if (pct == null) return "";
  if (pct >= 85) return "hot";
  if (pct >= 70) return "warn";
  return "";
}

function fmt(pct: number | null): string {
  if (pct == null) return "--";
  return `${Math.round(pct)}%`;
}

const pendingSleepIds = new Set<string>();
let sleepAllPending = false;

function markSleepPending(id: string): void {
  pendingSleepIds.add(id);
}

function clearSleepPending(id: string): void {
  pendingSleepIds.delete(id);
  if (pendingSleepIds.size === 0) sleepAllPending = false;
}

function syncSleepButtons(hosts: HostMetrics[]): void {
  for (const host of hosts) {
    if (host.online && pendingSleepIds.has(host.id)) {
      clearSleepPending(host.id);
    }
  }

  for (const host of hosts) {
    const btn = document.querySelector<HTMLButtonElement>(
      `.chip-sleep[data-sleep="${host.id}"]`,
    );
    if (!btn) continue;
    const waiting = pendingSleepIds.has(host.id);
    btn.disabled = waiting;
    btn.textContent = waiting ? "zzz" : "sleep";
  }

  const allBtn = document.getElementById("sleep-all") as HTMLButtonElement | null;
  if (allBtn) {
    const waitingAll = sleepAllPending && pendingSleepIds.size > 0;
    allBtn.disabled = waitingAll;
    allBtn.textContent = waitingAll ? "zzz" : "sleep all";
  }
}

function meterRow(label: string, pct: number | null): string {
  return `
    <div class="meter">
      <span>${label}</span>
      <div class="track"><div class="fill ${levelClass(pct)}" style="width:${pct ?? 0}%"></div></div>
      <span class="val">${fmt(pct)}</span>
    </div>
  `;
}

function fleetStatusClass(host: HostMetrics): string {
  if (!host.hostCount) return "dot off";
  if ((host.onlineCount || 0) >= host.hostCount) return "dot on";
  if ((host.onlineCount || 0) > 0) return "dot mid";
  return "dot off";
}

function renderHost(host: HostMetrics): string {
  const cpu = host.cpuPercent;
  const mem = host.memPercent;
  const gpu = host.gpuPercent;
  const isFleet = Boolean(host.synthetic || host.id === "fleet");
  const nameClass = host.online || isFleet ? "name" : "name off";
  const waiting = pendingSleepIds.has(host.id);
  const statusClass = isFleet ? fleetStatusClass(host) : host.online ? "dot on" : "dot off";
  const title = isFleet
    ? `avg of online hosts · ${host.onlineCount || 0}/${host.hostCount || 0} available`
    : host.error || host.label;
  const action = isFleet
    ? `<span class="chip chip-avail" title="Availability">${host.onlineCount || 0}/${host.hostCount || 0}</span>`
    : `<button type="button" class="chip chip-sleep" data-sleep="${host.id}" title="Sleep ${host.label}"${waiting ? " disabled" : ""}>${waiting ? "zzz" : "sleep"}</button>`;
  const meters = `${meterRow("cpu", cpu)}${meterRow("mem", mem)}${meterRow("gpu", gpu)}`;
  return `
    <section class="row${isFleet ? " row-fleet" : ""}" data-id="${host.id}">
      <div class="host-meta">
        <div class="host-title">
          <span class="${statusClass}" aria-hidden="true"></span>
          <div class="${nameClass}" title="${title}">${host.label}</div>
        </div>
        ${action}
      </div>
      <div class="meters${isFleet ? " meters-fleet" : ""}">
        ${meters}
      </div>
    </section>
  `;
}

let lastPayload: MetricsPayload | null = null;

function isFleetHost(host: HostMetrics): boolean {
  return Boolean(host.synthetic || host.id === "fleet");
}

function render(payload: MetricsPayload): void {
  const hosts = document.getElementById("hosts");
  const foot = document.getElementById("foot");
  if (!hosts || !foot) return;

  lastPayload = payload;

  for (const host of payload.hosts) {
    if (host.online && pendingSleepIds.has(host.id)) {
      clearSleepPending(host.id);
    }
  }

  const visible = showFleet
    ? payload.hosts
    : payload.hosts.filter((h) => !isFleetHost(h));
  hosts.innerHTML = visible.map(renderHost).join("");
  syncSleepButtons(payload.hosts.filter((h) => !isFleetHost(h)));

  const stamp = new Date(payload.polledAt).toLocaleTimeString();
  const real = payload.hosts.filter((h) => !isFleetHost(h));
  const online = real.filter((h) => h.online).length;
  if (!pendingSleepIds.size && !isSleepTimerActive()) {
    const offline = real.filter((h) => !h.online).map((h) => h.label);
    foot.textContent = offline.length
      ? `${online}/${real.length} up · down: ${offline.join(", ")} · ${stamp}`
      : `${online}/${real.length} up · ${stamp}`;
  }
}

function syncLayoutMode(): void {
  const shell = document.getElementById("shell");
  if (!shell) return;
  const wideEnough = shell.clientWidth >= 520;
  const shortEnough = shell.clientHeight <= 160;
  shell.classList.toggle("is-columns", wideEnough && shortEnough);
}

type Theme = "dark" | "light";

const THEME_KEY = "pc-monitor-theme";
const FLEET_KEY = "pc-monitor-show-fleet";

let showFleet = false;

function readFleetVisible(): boolean {
  return localStorage.getItem(FLEET_KEY) === "1";
}

function applyFleetUi(visible: boolean): void {
  showFleet = visible;
  const btn = document.getElementById("fleet");
  if (!btn) return;
  btn.classList.toggle("chip-active", visible);
  btn.setAttribute("aria-pressed", String(visible));
  btn.title = visible ? "Hide fleet summary" : "Show fleet summary";
}

function toggleFleet(): void {
  const next = !showFleet;
  localStorage.setItem(FLEET_KEY, next ? "1" : "0");
  applyFleetUi(next);
  if (lastPayload) {
    render(lastPayload);
    syncLayoutMode();
  }
  setFoot(next ? "fleet shown" : "fleet hidden");
}

function readTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "light" ? "light" : "dark";
}

function applyTheme(theme: Theme): void {
  document.body.dataset.theme = theme;
  const btn = document.getElementById("theme");
  if (btn) {
    btn.textContent = theme === "dark" ? "L" : "D";
    btn.title = theme === "dark" ? "Light mode" : "Dark mode";
    btn.setAttribute("aria-label", btn.title);
  }
}

function toggleTheme(): void {
  const next: Theme = readTheme() === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

let pinnedOnTop = true;

function applyPinUi(onTop: boolean): void {
  pinnedOnTop = onTop;
  const btn = document.getElementById("pin");
  if (!btn) return;
  btn.textContent = onTop ? "top" : "norm";
  btn.classList.toggle("chip-active", onTop);
  btn.setAttribute("aria-pressed", String(onTop));
  btn.title = onTop
    ? "Always on top enabled (click for default window level)"
    : "Default window level (click to keep always on top)";
}

async function togglePin(): Promise<void> {
  const next = await window.pcMonitor.setAlwaysOnTop(!pinnedOnTop);
  applyPinUi(next);
  setFoot(next ? "pinned on top" : "default window level");
}

function setFoot(message: string): void {
  const foot = document.getElementById("foot");
  if (foot) foot.textContent = message;
}

async function requestSleep(id: string, label: string): Promise<void> {
  if (!window.confirm(`Sleep ${label} now?`)) return;
  markSleepPending(id);
  const btn = document.querySelector<HTMLButtonElement>(
    `.chip-sleep[data-sleep="${id}"]`,
  );
  if (btn) {
    btn.disabled = true;
    btn.textContent = "zzz";
  }
  setFoot(`sleeping ${label}...`);
  const result = await window.pcMonitor.sleepHost(id);
  if (result.ok) {
    setFoot(`${label} sleep sent`);
  } else {
    clearSleepPending(id);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "sleep";
    }
    setFoot(`${label} sleep failed`);
    window.alert(`${label} sleep failed: ${result.error || "unknown error"}`);
  }
}

let timerEditOpen = false;

function defaultTimerSuggestion(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 30);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function applyTimerUi(label: string | null, targetAt: number | null): void {
  const btn = document.getElementById("sleep-timer");
  if (!btn) return;
  const active = targetAt != null;
  btn.classList.toggle("chip-timer-on", active);
  btn.setAttribute("aria-pressed", String(active));
  btn.hidden = timerEditOpen;
  if (active && label) {
    btn.textContent = label;
    btn.title = `Sleep all at ${formatTargetLabel(targetAt)} (click to cancel)`;
  } else {
    btn.textContent = "timer";
    btn.title = "Set sleep-all timer (HH:MM 24h)";
  }
}

function closeTimerEdit(): void {
  timerEditOpen = false;
  const edit = document.getElementById("timer-edit");
  edit?.classList.remove("is-open");
  edit?.setAttribute("hidden", "");
  const active = getSleepTimerTarget();
  applyTimerUi(active && isSleepTimerActive() ? "..." : null, active);
}

function openTimerEdit(): void {
  timerEditOpen = true;
  const edit = document.getElementById("timer-edit");
  const input = document.getElementById("timer-input") as HTMLInputElement | null;
  const btn = document.getElementById("sleep-timer");
  if (btn) btn.hidden = true;
  edit?.classList.add("is-open");
  edit?.removeAttribute("hidden");
  if (input) {
    input.value = defaultTimerSuggestion();
    input.focus();
    input.select();
  }
  setFoot("enter HH:MM then set");
}

function commitTimerEdit(): void {
  const input = document.getElementById("timer-input") as HTMLInputElement | null;
  const raw = (input?.value || "").trim();
  const parsed = parseHhMm(raw);
  if (!parsed) {
    setFoot("use 24h HH:MM, e.g. 23:30");
    input?.focus();
    input?.select();
    return;
  }
  const target = nextOccurrence(parsed.hour, parsed.minute);
  timerEditOpen = false;
  const edit = document.getElementById("timer-edit");
  edit?.classList.remove("is-open");
  edit?.setAttribute("hidden", "");
  setSleepTimer(target.getTime());
  setFoot(`timer set for ${formatTargetLabel(target.getTime())}`);
}

function onSleepTimerClick(): void {
  if (isSleepTimerActive()) {
    clearSleepTimer();
    setFoot("timer cancelled");
    return;
  }
  openTimerEdit();
}

async function executeSleepAll(options: { confirm: boolean }): Promise<void> {
  if (options.confirm) {
    if (
      !window.confirm(
        "Sleep ALL hosts now? Remotes first, then this Mac. You will need to wake them manually.",
      )
    ) {
      return;
    }
  }
  sleepAllPending = true;
  document.querySelectorAll<HTMLButtonElement>(".chip-sleep").forEach((btn) => {
    const id = btn.dataset.sleep;
    if (id) markSleepPending(id);
    btn.disabled = true;
    btn.textContent = "zzz";
  });
  const allBtn = document.getElementById("sleep-all") as HTMLButtonElement | null;
  if (allBtn) {
    allBtn.disabled = true;
    allBtn.textContent = "zzz";
  }
  setFoot(options.confirm ? "sleeping all hosts..." : "timer fired - sleeping all...");
  const results = await window.pcMonitor.sleepAll();
  const failed = results.filter((r) => !r.ok);
  for (const result of failed) {
    clearSleepPending(result.id);
  }
  if (failed.length) {
    setFoot(`sleep all partial (${results.length - failed.length}/${results.length})`);
    syncSleepButtons(
      results.map((r) => ({
        id: r.id,
        label: r.label,
        cpuPercent: null,
        memPercent: null,
        gpuPercent: null,
        availPercent: null,
        online: !pendingSleepIds.has(r.id),
      })),
    );
    if (options.confirm) {
      window.alert(
        failed.map((r) => `${r.label}: ${r.error || "failed"}`).join("\n"),
      );
    }
  } else {
    setFoot("sleep all sent");
  }
}

async function requestSleepAll(): Promise<void> {
  await executeSleepAll({ confirm: true });
}

document.getElementById("quit")?.addEventListener("click", () => {
  window.pcMonitor.quit();
});

document.getElementById("restart")?.addEventListener("click", () => {
  setFoot("restarting...");
  window.pcMonitor.restart();
});

document.getElementById("theme")?.addEventListener("click", () => {
  toggleTheme();
});

document.getElementById("pin")?.addEventListener("click", () => {
  void togglePin();
});

document.getElementById("fleet")?.addEventListener("click", () => {
  toggleFleet();
});

document.getElementById("sleep-all")?.addEventListener("click", () => {
  void requestSleepAll();
});

document.getElementById("sleep-timer")?.addEventListener("click", () => {
  onSleepTimerClick();
});

document.getElementById("timer-set")?.addEventListener("click", () => {
  commitTimerEdit();
});

document.getElementById("timer-cancel-edit")?.addEventListener("click", () => {
  closeTimerEdit();
  setFoot("timer edit cancelled");
});

document.getElementById("timer-input")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    commitTimerEdit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeTimerEdit();
    setFoot("timer edit cancelled");
  }
});

document.getElementById("hosts")?.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const btn = target?.closest?.(".chip-sleep") as HTMLButtonElement | null;
  if (!btn || btn.disabled) return;
  const id = btn.dataset.sleep;
  if (!id) return;
  const row = btn.closest(".row");
  const label =
    row?.querySelector(".name")?.textContent?.trim() || id;
  void requestSleep(id, label);
});

applyTheme(readTheme());
applyFleetUi(readFleetVisible());
void window.pcMonitor.getAlwaysOnTop().then((onTop) => applyPinUi(onTop));

initSleepTimer({
  onTick: (label, at) => {
    if (timerEditOpen) return;
    applyTimerUi(label, at);
    if (!pendingSleepIds.size) {
      setFoot(`sleep all in ${label} · ${formatTargetLabel(at)}`);
    }
  },
  onIdle: () => {
    if (timerEditOpen) return;
    applyTimerUi(null, null);
  },
  onFire: () => executeSleepAll({ confirm: false }),
});

const restoredTimer = getSleepTimerTarget();
if (restoredTimer) applyTimerUi("...", restoredTimer);

const shellEl = document.getElementById("shell");
if (shellEl && typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(() => syncLayoutMode());
  ro.observe(shellEl);
}
window.addEventListener("resize", syncLayoutMode);
syncLayoutMode();

window.pcMonitor.onMetrics((payload) => {
  render(payload);
  syncLayoutMode();
});
