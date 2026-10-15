import { contextBridge, ipcRenderer } from "electron";
import type { HostId, MetricsPayload } from "@src/shared/hosts";

type SleepResult = {
  id: string;
  label: string;
  ok: boolean;
  error?: string;
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
});
