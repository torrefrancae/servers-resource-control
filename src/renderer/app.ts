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
  skipped?: boolean;
};

type ScheduleHostState = {
  id: string;
  label: string;
  kind: "linux" | "darwin";
  armed: boolean;
  detail: string;
  ok: boolean;
  error?: string;
};

type ScheduleState = {
  armed: boolean;
  hosts: ScheduleHostState[];
  updatedAt: number;
};

type PcMonitorApi = {
  onMetrics: (cb: (payload: MetricsPayload) => void) => () => void;
  quit: () => void;
  restart: () => void;
  getAlwaysOnTop: () => Promise<boolean>;
  setAlwaysOnTop: (next: boolean, persist?: boolean) => Promise<boolean>;
  sleepHost: (id: string) => Promise<SleepResult>;
  sleepAll: () => Promise<SleepResult[]>;
  restartHost: (id: string) => Promise<SleepResult>;
  restartAll: () => Promise<SleepResult[]>;
  getAutoSleepSchedule: () => Promise<ScheduleState>;
  setAutoSleepSchedule: (armed: boolean) => Promise<ScheduleState>;
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
let timerEditOpen = false;
let hostModalTarget: { id: string; label: string } | null = null;

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
      `.chip-host[data-host="${host.id}"]`,
    );
    if (!btn) continue;
    const waiting = pendingSleepIds.has(host.id);
    btn.disabled = waiting;
    btn.textContent = waiting ? "..." : "power";
  }

  syncGlobalBusyUi();
}

function syncGlobalBusyUi(): void {
  const toggle = document.getElementById("global-toggle") as HTMLButtonElement | null;
  if (!toggle || isSleepTimerActive() || timerEditOpen) return;
  const waitingAll = sleepAllPending && pendingSleepIds.size > 0;
  toggle.disabled = waitingAll;
  if (waitingAll) toggle.textContent = "zzz";
  else if (!toggle.classList.contains("chip-timer-on")) toggle.textContent = "global";
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
    : `<button type="button" class="chip chip-host" data-host="${host.id}" title="Power options for ${host.label}"${waiting ? " disabled" : ""}>${waiting ? "..." : "power"}</button>`;
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
let pinSticky = false;
let hoverUnpinTimer: ReturnType<typeof setTimeout> | null = null;
const HOVER_UNPIN_MS = 5 * 60 * 1000;

function applyPinUi(onTop: boolean): void {
  pinnedOnTop = onTop;
  const btn = document.getElementById("pin");
  if (!btn) return;
  btn.textContent = onTop ? "always on top" : "default level";
  btn.classList.toggle("chip-active", onTop);
  btn.setAttribute("aria-pressed", String(onTop));
  btn.title = onTop
    ? pinSticky
      ? "Sticky always on top (click for default / hover auto-pin)"
      : "Always on top for now (auto-off 5m after mouse leave)"
    : "Default level (hover pins; click to keep sticky on top)";
}

function clearHoverUnpinTimer(): void {
  if (!hoverUnpinTimer) return;
  clearTimeout(hoverUnpinTimer);
  hoverUnpinTimer = null;
}

async function setPin(onTop: boolean, persist: boolean): Promise<boolean> {
  const next = await window.pcMonitor.setAlwaysOnTop(onTop, persist);
  applyPinUi(next);
  return next;
}

async function togglePin(): Promise<void> {
  const next = !pinnedOnTop;
  pinSticky = next;
  clearHoverUnpinTimer();
  await setPin(next, true);
  setFoot(next ? "sticky pin on" : "default window level");
}

function onShellPointerEnter(): void {
  clearHoverUnpinTimer();
  if (pinnedOnTop) return;
  void setPin(true, false);
}

function onShellPointerLeave(): void {
  if (pinSticky) return;
  clearHoverUnpinTimer();
  hoverUnpinTimer = setTimeout(() => {
    hoverUnpinTimer = null;
    void setPin(false, false).then(() => {
      setFoot("auto pin off after 5m idle");
    });
  }, HOVER_UNPIN_MS);
}

function setFoot(message: string): void {
  const foot = document.getElementById("foot");
  if (foot) foot.textContent = message;
}

function closeHostMenu(): void {
  closeModal("host-modal", "");
}

function openHostMenu(id: string, label: string): void {
  closeModal("global-modal", "global-toggle");
  closeModal("app-modal", "app-toggle");
  hostModalTarget = { id, label };
  const modal = document.getElementById("host-modal");
  const title = document.getElementById("host-modal-title");
  if (title) title.textContent = label;
  modal?.classList.add("is-open");
  modal?.removeAttribute("hidden");
}

async function requestSleep(id: string, label: string): Promise<void> {
  if (!window.confirm(`Sleep ${label} now?`)) return;
  markSleepPending(id);
  const btn = document.querySelector<HTMLButtonElement>(
    `.chip-host[data-host="${id}"]`,
  );
  if (btn) {
    btn.disabled = true;
    btn.textContent = "...";
  }
  setFoot(`sleeping ${label}...`);
  const result = await window.pcMonitor.sleepHost(id);
  if (result.ok) {
    setFoot(`${label} sleep sent`);
  } else {
    clearSleepPending(id);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "power";
    }
    setFoot(`${label} sleep failed`);
    window.alert(`${label} sleep failed: ${result.error || "unknown error"}`);
  }
}

async function requestRestart(id: string, label: string): Promise<void> {
  if (
    !window.confirm(
      `Restart ${label} now? This force-reboots the machine.`,
    )
  ) {
    return;
  }
  markSleepPending(id);
  const btn = document.querySelector<HTMLButtonElement>(
    `.chip-host[data-host="${id}"]`,
  );
  if (btn) {
    btn.disabled = true;
    btn.textContent = "...";
  }
  setFoot(`restarting ${label}...`);
  const result = await window.pcMonitor.restartHost(id);
  if (result.ok) {
    setFoot(`${label} restart sent`);
  } else {
    clearSleepPending(id);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "power";
    }
    setFoot(`${label} restart failed`);
    window.alert(`${label} restart failed: ${result.error || "unknown error"}`);
  }
}

function defaultTimerSuggestion(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 30);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function applyTimerUi(label: string | null, targetAt: number | null): void {
  const btn = document.getElementById("global-toggle");
  const timerItem = document.getElementById("sleep-timer");
  if (!btn) return;
  const active = targetAt != null;
  btn.classList.toggle("chip-timer-on", active);
  btn.setAttribute("aria-pressed", String(active));
  if (active && label) {
    btn.textContent = label;
    btn.title = `Sleep all at ${formatTargetLabel(targetAt)} (click global menu; timer all cancels)`;
  } else if (!timerEditOpen) {
    btn.textContent = "global";
    btn.title = "Global actions";
  }
  if (timerItem) {
    timerItem.textContent = active ? "cancel timer" : "timer all";
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
  closeGlobalMenu();
  const edit = document.getElementById("timer-edit");
  const input = document.getElementById("timer-input") as HTMLInputElement | null;
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
  closeGlobalMenu();
  if (isSleepTimerActive()) {
    clearSleepTimer();
    setFoot("timer cancelled");
    return;
  }
  openTimerEdit();
}

function closeModal(id: string, toggleId: string): void {
  const modal = document.getElementById(id);
  const toggle = toggleId ? document.getElementById(toggleId) : null;
  modal?.classList.remove("is-open");
  modal?.setAttribute("hidden", "");
  toggle?.setAttribute("aria-expanded", "false");
  if (id === "host-modal") hostModalTarget = null;
}

function openModal(id: string, toggleId: string): void {
  closeModal("global-modal", "global-toggle");
  closeModal("app-modal", "app-toggle");
  closeModal("host-modal", "");
  const modal = document.getElementById(id);
  const toggle = toggleId ? document.getElementById(toggleId) : null;
  modal?.classList.add("is-open");
  modal?.removeAttribute("hidden");
  toggle?.setAttribute("aria-expanded", "true");
}

function closeGlobalMenu(): void {
  closeModal("global-modal", "global-toggle");
}

function openGlobalMenu(): void {
  openModal("global-modal", "global-toggle");
}

function toggleGlobalMenu(): void {
  const modal = document.getElementById("global-modal");
  if (modal?.classList.contains("is-open")) closeGlobalMenu();
  else openGlobalMenu();
}

function closeAppMenu(): void {
  closeModal("app-modal", "app-toggle");
}

function openAppMenu(): void {
  openModal("app-modal", "app-toggle");
}

function toggleAppMenu(): void {
  const modal = document.getElementById("app-modal");
  if (modal?.classList.contains("is-open")) closeAppMenu();
  else openAppMenu();
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
  document.querySelectorAll<HTMLButtonElement>(".chip-host").forEach((btn) => {
    const id = btn.dataset.host;
    if (id) markSleepPending(id);
    btn.disabled = true;
    btn.textContent = "...";
  });
  syncGlobalBusyUi();
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
  syncGlobalBusyUi();
}

async function requestSleepAll(): Promise<void> {
  await executeSleepAll({ confirm: true });
}

async function requestRestartAll(): Promise<void> {
  if (
    !window.confirm(
      "Restart ALL hosts? Remotes first (forced). This Mac restarts only if every remote succeeds.",
    )
  ) {
    return;
  }
  closeGlobalMenu();
  const toggle = document.getElementById("global-toggle") as HTMLButtonElement | null;
  if (toggle) {
    toggle.disabled = true;
    toggle.textContent = "rebooting";
  }
  setFoot("restarting remotes...");
  const results = await window.pcMonitor.restartAll();
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  if (failed.length) {
    setFoot(
      skipped.length
        ? `restart aborted - remotes failed (${results.length - failed.length}/${results.length - skipped.length})`
        : `restart partial (${results.length - failed.length}/${results.length})`,
    );
    window.alert(
      failed
        .map((r) => `${r.label}: ${r.error || (r.skipped ? "skipped" : "failed")}`)
        .join("\n"),
    );
  } else {
    setFoot("restart all sent");
  }
  if (toggle && !isSleepTimerActive()) {
    toggle.disabled = false;
    toggle.textContent = "global";
  }
}

let scheduleArmed: boolean | null = null;
let scheduleBusy = false;

function applyScheduleUi(state: ScheduleState | null): void {
  const btn = document.getElementById("auto-sleep") as HTMLButtonElement | null;
  if (!btn) return;
  if (!state) {
    btn.textContent = "disable auto sleep";
    btn.classList.remove("chip-warn", "chip-active");
    btn.title = "Loading auto-sleep schedule...";
    btn.disabled = scheduleBusy;
    return;
  }
  scheduleArmed = state.armed;
  btn.disabled = scheduleBusy;
  btn.textContent = state.armed ? "disable auto sleep" : "enable auto sleep";
  btn.classList.toggle("chip-warn", state.armed);
  btn.classList.toggle("chip-active", !state.armed);
  btn.setAttribute("aria-pressed", String(state.armed));
  const parts = state.hosts.map((h) => {
    if (!h.ok) return `${h.label}: error`;
    return `${h.label}: ${h.armed ? "armed" : "off"}`;
  });
  btn.title = state.armed
    ? `Auto sleep ON (${parts.join(", ")}). Click to disable.`
    : `Auto sleep OFF (${parts.join(", ")}). Click to enable.`;
}

async function refreshScheduleUi(): Promise<void> {
  try {
    const state = await window.pcMonitor.getAutoSleepSchedule();
    applyScheduleUi(state);
  } catch {
    applyScheduleUi(null);
    setFoot("5am schedule status failed");
  }
}

async function toggleAutoSleepSchedule(): Promise<void> {
  if (scheduleBusy) return;
  const next = !(scheduleArmed ?? true);
  scheduleBusy = true;
  applyScheduleUi(
    scheduleArmed == null
      ? null
      : {
          armed: scheduleArmed,
          hosts: [],
          updatedAt: Date.now(),
        },
  );
  const btn = document.getElementById("auto-sleep") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "...";
  }
  setFoot(next ? "enabling auto sleep..." : "disabling auto sleep...");
  try {
    const state = await window.pcMonitor.setAutoSleepSchedule(next);
    applyScheduleUi(state);
    const failed = state.hosts.filter((h) => !h.ok);
    if (failed.length) {
      setFoot(
        `auto sleep partial: ${failed.map((h) => h.label).join(", ")}`,
      );
    } else {
      setFoot(state.armed ? "auto sleep armed" : "auto sleep disabled");
    }
  } catch {
    setFoot("auto sleep toggle failed");
    await refreshScheduleUi();
  } finally {
    scheduleBusy = false;
    await refreshScheduleUi();
  }
}

document.getElementById("quit")?.addEventListener("click", () => {
  window.pcMonitor.quit();
});

document.getElementById("theme")?.addEventListener("click", () => {
  toggleTheme();
});

document.getElementById("fleet")?.addEventListener("click", () => {
  toggleFleet();
});

document.getElementById("global-toggle")?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleGlobalMenu();
});

document.getElementById("app-toggle")?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleAppMenu();
});

document.getElementById("global-backdrop")?.addEventListener("click", () => {
  closeGlobalMenu();
});

document.getElementById("app-backdrop")?.addEventListener("click", () => {
  closeAppMenu();
});

document.getElementById("host-backdrop")?.addEventListener("click", () => {
  closeHostMenu();
});

document.getElementById("global-modal")?.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const item = target?.closest?.("[data-global]") as HTMLButtonElement | null;
  if (!item) return;
  const action = item.dataset.global;
  if (action === "restart-all") void requestRestartAll();
  else if (action === "sleep-all") {
    closeGlobalMenu();
    void requestSleepAll();
  } else if (action === "timer-all") onSleepTimerClick();
  else if (action === "auto-sleep") void toggleAutoSleepSchedule();
});

document.getElementById("app-modal")?.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const item = target?.closest?.("[data-app]") as HTMLButtonElement | null;
  if (!item) return;
  const action = item.dataset.app;
  if (action === "restart") {
    closeAppMenu();
    setFoot("restarting...");
    window.pcMonitor.restart();
  } else if (action === "pin") {
    void togglePin();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeGlobalMenu();
    closeAppMenu();
    closeHostMenu();
  }
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
  const btn = target?.closest?.(".chip-host") as HTMLButtonElement | null;
  if (!btn || btn.disabled) return;
  const id = btn.dataset.host;
  if (!id) return;
  const row = btn.closest(".row");
  const label =
    row?.querySelector(".name")?.textContent?.trim() || id;
  openHostMenu(id, label);
});

document.getElementById("host-modal")?.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const item = target?.closest?.("[data-host-action]") as HTMLButtonElement | null;
  if (!item || !hostModalTarget) return;
  const action = item.dataset.hostAction;
  const { id, label } = hostModalTarget;
  closeHostMenu();
  if (action === "sleep") void requestSleep(id, label);
  else if (action === "restart") void requestRestart(id, label);
});

applyTheme(readTheme());
applyFleetUi(readFleetVisible());
void window.pcMonitor.getAlwaysOnTop().then((onTop) => {
  pinSticky = onTop;
  applyPinUi(onTop);
});
void refreshScheduleUi();

const shellHoverEl = document.getElementById("shell");
shellHoverEl?.addEventListener("mouseenter", onShellPointerEnter);
shellHoverEl?.addEventListener("mouseleave", onShellPointerLeave);
setInterval(() => {
  void refreshScheduleUi();
}, 60000);

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
