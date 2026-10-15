import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { POLL_MS } from "@src/shared/hosts";
import { pollAll } from "@src/main/metrics";
import {
  applyWindowBounds,
  loadWindowState,
  saveAlwaysOnTop,
  trackWindowState,
} from "@src/main/window-state";
import { sleepHost, sleepHosts } from "@src/main/sleep";
import type { HostId } from "@src/shared/hosts";

function migrateLegacyUserData(): void {
  const appData = app.getPath("appData");
  const legacy = path.join(appData, "pc-resource-monitor");
  const next = app.getPath("userData");
  if (legacy === next || !fs.existsSync(legacy) || fs.existsSync(next)) return;
  try {
    fs.cpSync(legacy, next, { recursive: true });
  } catch {
    /* keep going with defaults if migrate fails */
  }
}

const WIN_W = 280;
const WIN_H = 210;
const WIN_MIN_W = 200;
const WIN_MIN_H = 110;
const WIN_MAX_W = 760;
const WIN_MAX_H = 520;

const WIN_LIMITS = {
  minWidth: WIN_MIN_W,
  minHeight: WIN_MIN_H,
  maxWidth: WIN_MAX_W,
  maxHeight: WIN_MAX_H,
  defaultWidth: WIN_W,
  defaultHeight: WIN_H,
};

/* macOS screen-saver level sits above normal app windows and most overlays */
const PIN_LEVEL = "screen-saver" as const;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let polling = false;
let flushWindowState: (() => void) | null = null;
let alwaysOnTop = true;

function applyPinState(target: BrowserWindow | null = win): void {
  if (!target || target.isDestroyed()) return;
  if (alwaysOnTop) {
    target.setAlwaysOnTop(true, PIN_LEVEL);
    target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    target.moveTop();
  } else {
    target.setAlwaysOnTop(false);
    target.setVisibleOnAllWorkspaces(false);
  }
}

function pinOnTop(target: BrowserWindow | null = win): void {
  applyPinState(target);
}

function createWindow(): void {
  const saved = loadWindowState(WIN_LIMITS);
  alwaysOnTop = saved.alwaysOnTop !== false;
  console.log(
    `[window-state] restore ${saved.width}x${saved.height} @ ${saved.x},${saved.y} top=${alwaysOnTop}`,
  );

  win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: WIN_MIN_W,
    minHeight: WIN_MIN_H,
    maxWidth: WIN_MAX_W,
    maxHeight: WIN_MAX_H,
    frame: false,
    transparent: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    minimizable: true,
    alwaysOnTop,
    skipTaskbar: true,
    hasShadow: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  flushWindowState = trackWindowState(win, WIN_LIMITS);
  applyWindowBounds(win, saved);
  pinOnTop(win);
  if (process.platform === "darwin") {
    win.setWindowButtonVisibility(false);
  }
  win.loadFile(path.join(__dirname, "../renderer/index.html"));

  win.once("ready-to-show", () => {
    applyWindowBounds(win!, saved);
    pinOnTop(win);
    win?.showInactive();
    applyWindowBounds(win!, saved);
    pinOnTop(win);
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      applyWindowBounds(win, saved);
      const live = win.getBounds();
      console.log(
        `[window-state] applied ${live.width}x${live.height} @ ${live.x},${live.y}`,
      );
    }, 50);
  });

  win.on("show", () => pinOnTop(win));
  win.on("focus", () => pinOnTop(win));
  win.on("blur", () => pinOnTop(win));
  win.on("closed", () => {
    flushWindowState?.();
    flushWindowState = null;
    win = null;
  });
}

function createTray(): void {
  const iconPath = path.join(__dirname, "../../assets/tray.png");
  const img = nativeImage.createFromPath(iconPath);
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip("Servers resource control");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show",
        click: () => {
          win?.show();
          pinOnTop(win);
        },
      },
      {
        label: "Hide",
        click: () => win?.hide(),
      },
      {
        label: "Bring to front",
        click: () => {
          win?.show();
          pinOnTop(win);
        },
      },
      {
        label: "Restart",
        click: () => {
          flushWindowState?.();
          app.relaunch({ args: process.argv.slice(1) });
          app.exit(0);
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => app.quit(),
      },
    ]),
  );
  tray.on("click", () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else {
      win.show();
      pinOnTop(win);
    }
  });
}

async function tick(): Promise<void> {
  if (polling || !win || win.isDestroyed()) return;
  polling = true;
  try {
    const payload = await pollAll();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send("metrics", payload);
  } catch {
    /* ignore transient ipc/frame races while the window reloads */
  } finally {
    polling = false;
  }
}

function startPolling(): void {
  void tick();
  pollTimer = setInterval(() => {
    void tick();
  }, POLL_MS);
}

app.whenReady().then(() => {
  migrateLegacyUserData();
  if (process.platform === "darwin") {
    app.dock?.hide();
  }
  createWindow();
  createTray();
  startPolling();

  ipcMain.on("window-drag", () => {
    /* drag handled via -webkit-app-region in CSS */
  });
  ipcMain.on("quit-app", () => app.quit());
  ipcMain.on("restart-app", () => {
    flushWindowState?.();
    app.relaunch({ args: process.argv.slice(1) });
    app.exit(0);
  });
  ipcMain.handle("get-always-on-top", () => alwaysOnTop);
  ipcMain.handle("set-always-on-top", (_event, next: boolean) => {
    alwaysOnTop = Boolean(next);
    applyPinState(win);
    saveAlwaysOnTop(win, WIN_LIMITS, alwaysOnTop);
    return alwaysOnTop;
  });
  ipcMain.handle("sleep-host", async (_event, id: HostId) => sleepHost(id));
  ipcMain.handle("sleep-all", async () => sleepHosts());
});

app.on("window-all-closed", () => {
  if (pollTimer) clearInterval(pollTimer);
  app.quit();
});

app.on("before-quit", () => {
  flushWindowState?.();
  if (pollTimer) clearInterval(pollTimer);
  tray?.destroy();
});
