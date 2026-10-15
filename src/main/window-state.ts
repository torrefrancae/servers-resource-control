import { app, screen, BrowserWindow, Rectangle } from "electron";
import fs from "node:fs";
import path from "node:path";

export type WindowState = {
  x: number;
  y: number;
  width: number;
  height: number;
  alwaysOnTop?: boolean;
};

type BoundsLimits = {
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  defaultWidth: number;
  defaultHeight: number;
};

function statePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function defaultState(limits: BoundsLimits): WindowState {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: limits.defaultWidth,
    height: limits.defaultHeight,
    x: Math.max(12, width - limits.defaultWidth - 18),
    y: Math.max(12, height - limits.defaultHeight - 18),
    alwaysOnTop: true,
  };
}

function fitToDisplay(state: WindowState): WindowState {
  const bounds: Rectangle = {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
  };
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const width = Math.min(state.width, area.width);
  const height = Math.min(state.height, area.height);
  let x = state.x;
  let y = state.y;

  if (x + width < area.x + 40) x = area.x;
  if (y + height < area.y + 40) y = area.y;
  if (x > area.x + area.width - 40) x = area.x + area.width - width;
  if (y > area.y + area.height - 40) y = area.y + area.height - height;

  x = clamp(x, area.x - Math.floor(width * 0.5), area.x + area.width - Math.floor(width * 0.5));
  y = clamp(y, area.y - Math.floor(height * 0.5), area.y + area.height - Math.floor(height * 0.5));

  return {
    x,
    y,
    width,
    height,
    alwaysOnTop: state.alwaysOnTop ?? true,
  };
}

export function loadWindowState(limits: BoundsLimits): WindowState {
  const fallback = defaultState(limits);
  try {
    const raw = fs.readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<WindowState>;
    const next: WindowState = {
      x: Number(parsed.x),
      y: Number(parsed.y),
      width: Number(parsed.width),
      height: Number(parsed.height),
      alwaysOnTop: parsed.alwaysOnTop !== false,
    };
    if (
      ![next.x, next.y, next.width, next.height].every((n) => Number.isFinite(n))
    ) {
      return fallback;
    }
    next.width = clamp(next.width, limits.minWidth, limits.maxWidth);
    next.height = clamp(next.height, limits.minHeight, limits.maxHeight);
    return fitToDisplay(next);
  } catch {
    return fallback;
  }
}

export function saveWindowState(bounds: WindowState): void {
  try {
    const file = statePath();
    let prev: Partial<WindowState> = {};
    try {
      prev = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WindowState>;
    } catch {
      /* new file */
    }
    const merged: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      alwaysOnTop: bounds.alwaysOnTop ?? prev.alwaysOnTop ?? true,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  } catch {
    /* ignore disk errors */
  }
}

export function saveAlwaysOnTop(
  target: BrowserWindow | null,
  limits: BoundsLimits,
  alwaysOnTop: boolean,
): void {
  const state = loadWindowState(limits);
  if (target && !target.isDestroyed()) {
    const b = target.getBounds();
    saveWindowState({
      x: b.x,
      y: b.y,
      width: clamp(b.width, limits.minWidth, limits.maxWidth),
      height: clamp(b.height, limits.minHeight, limits.maxHeight),
      alwaysOnTop,
    });
    return;
  }
  saveWindowState({ ...state, alwaysOnTop });
}

export function applyWindowBounds(
  target: BrowserWindow,
  state: WindowState,
): void {
  if (target.isDestroyed()) return;
  const fitted = fitToDisplay(state);
  target.setBounds(
    {
      x: Math.round(fitted.x),
      y: Math.round(fitted.y),
      width: Math.round(fitted.width),
      height: Math.round(fitted.height),
    },
    false,
  );
}

export function trackWindowState(
  target: BrowserWindow,
  limits: BoundsLimits,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const persist = (): void => {
    if (target.isDestroyed()) return;
    const b = target.getBounds();
    saveWindowState({
      x: b.x,
      y: b.y,
      width: clamp(b.width, limits.minWidth, limits.maxWidth),
      height: clamp(b.height, limits.minHeight, limits.maxHeight),
    });
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(persist, 80);
  };

  target.on("resize", schedule);
  target.on("moved", schedule);
  target.on("move", schedule);
  target.on("close", persist);

  return () => {
    if (timer) clearTimeout(timer);
    persist();
  };
}
