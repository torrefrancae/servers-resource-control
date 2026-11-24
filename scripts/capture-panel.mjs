import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "docs", "panel.png");
const { pollAll } = require("../dist/main/metrics.js");

ipcMain.handle("get-always-on-top", () => false);
ipcMain.handle("set-always-on-top", (_e, next) => Boolean(next));
ipcMain.handle("get-auto-sleep-schedule", () => ({
  armed: false,
  hosts: [],
  updatedAt: Date.now(),
}));
ipcMain.handle("set-auto-sleep-schedule", (_e, armed) => ({
  armed: Boolean(armed),
  hosts: [],
  updatedAt: Date.now(),
}));
ipcMain.handle("get-host-settings", () => []);
ipcMain.handle("save-host-settings", (_e, rows) => rows);
ipcMain.handle("set-settings-layout", () => true);
ipcMain.handle("sleep-host", async () => ({ id: "", label: "", ok: false }));
ipcMain.handle("sleep-all", async () => []);
ipcMain.handle("restart-host", async () => ({ id: "", label: "", ok: false }));
ipcMain.handle("restart-all", async () => []);
ipcMain.on("quit-app", () => app.quit());
ipcMain.on("restart-app", () => app.quit());

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100,
    height: 150,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(root, "dist", "main", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await win.loadFile(path.join(root, "dist", "renderer", "index.html"));
  await new Promise((resolve) => {
    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", resolve);
    } else {
      resolve();
    }
  });

  const payload = await Promise.race([
    pollAll(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("poll timeout")), 20000),
    ),
  ]);
  win.webContents.send("metrics", payload);
  await new Promise((r) => setTimeout(r, 1500));

  const image = await win.webContents.capturePage();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  const size = image.getSize();
  console.log(`wrote ${out} (${size.width}x${size.height})`);
  app.exit(0);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});

app.on("window-all-closed", () => app.quit());
