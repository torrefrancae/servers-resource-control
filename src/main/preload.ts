import { contextBridge, ipcRenderer } from "electron";
import type { HostId, MetricsPayload } from "@src/shared/hosts";

type SleepResult = {
  id: string;
  label: string;
  ok: boolean;
  error?: string;
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

contextBridge.exposeInMainWorld("pcMonitor", {
  onMetrics: (cb: (payload: MetricsPayload) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: MetricsPayload,
    ) => {
      cb(payload);
    };
    ipcRenderer.on("metrics", listener);
    return () => ipcRenderer.removeListener("metrics", listener);
  },
  quit: () => ipcRenderer.send("quit-app"),
  restart: () => ipcRenderer.send("restart-app"),
  getAlwaysOnTop: (): Promise<boolean> =>
    ipcRenderer.invoke("get-always-on-top"),
  setAlwaysOnTop: (next: boolean): Promise<boolean> =>
    ipcRenderer.invoke("set-always-on-top", next),
  sleepHost: (id: HostId): Promise<SleepResult> =>
    ipcRenderer.invoke("sleep-host", id),
  sleepAll: (): Promise<SleepResult[]> => ipcRenderer.invoke("sleep-all"),
  getAutoSleepSchedule: (): Promise<ScheduleState> =>
    ipcRenderer.invoke("get-auto-sleep-schedule"),
  setAutoSleepSchedule: (armed: boolean): Promise<ScheduleState> =>
    ipcRenderer.invoke("set-auto-sleep-schedule", armed),
});
