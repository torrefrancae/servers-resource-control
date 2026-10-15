const TIMER_KEY = "pc-monitor-sleep-timer-at";

export type SleepTimerHooks = {
  onTick: (label: string, targetAt: number) => void;
  onIdle: () => void;
  onFire: () => void | Promise<void>;
};

let targetAt: number | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let firing = false;
let hooks: SleepTimerHooks | null = null;

export function getSleepTimerTarget(): number | null {
  return targetAt;
}

export function isSleepTimerActive(): boolean {
  return targetAt != null && targetAt > Date.now();
}

export function parseHhMm(input: string): { hour: number; minute: number } | null {
  const match = input.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export function nextOccurrence(hour: number, minute: number, now = new Date()): Date {
  const target = new Date(now);
  target.setSeconds(0, 0);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target;
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatTargetLabel(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function persist(): void {
  if (targetAt == null) localStorage.removeItem(TIMER_KEY);
  else localStorage.setItem(TIMER_KEY, String(targetAt));
}

function clearTick(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

async function fire(): Promise<void> {
  if (firing) return;
  firing = true;
  const at = targetAt;
  targetAt = null;
  persist();
  clearTick();
  hooks?.onIdle();
  try {
    await hooks?.onFire();
  } finally {
    firing = false;
    if (at != null) {
      /* keep quiet after fire; onFire handles foot text */
    }
  }
}

function tick(): void {
  if (targetAt == null) return;
  const remain = targetAt - Date.now();
  if (remain <= 0) {
    void fire();
    return;
  }
  hooks?.onTick(formatCountdown(remain), targetAt);
}

function startTicking(): void {
  clearTick();
  tick();
  tickTimer = setInterval(tick, 1000);
}

export function clearSleepTimer(): void {
  targetAt = null;
  persist();
  clearTick();
  hooks?.onIdle();
}

export function setSleepTimer(at: number): void {
  if (!Number.isFinite(at) || at <= Date.now()) {
    clearSleepTimer();
    return;
  }
  targetAt = at;
  persist();
  startTicking();
}

export function initSleepTimer(nextHooks: SleepTimerHooks): void {
  hooks = nextHooks;
  const raw = localStorage.getItem(TIMER_KEY);
  const restored = raw ? Number(raw) : NaN;
  if (Number.isFinite(restored) && restored > Date.now()) {
    targetAt = restored;
    startTicking();
    return;
  }
  if (raw) localStorage.removeItem(TIMER_KEY);
  hooks.onIdle();
}
