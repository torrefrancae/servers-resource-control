export type HostSettingsRow = {
  id: string;
  label: string;
  kind: "linux" | "darwin";
  source: "local" | "ssh";
  enabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshPassword: string;
  sshScript: string;
};

type HostsSettingsApi = {
  getHostSettings: () => Promise<HostSettingsRow[]>;
  saveHostSettings: (rows: HostSettingsRow[]) => Promise<HostSettingsRow[]>;
  setSettingsLayout?: (open: boolean) => Promise<boolean>;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function blankRemote(): HostSettingsRow {
  return {
    id: "",
    label: "new-host",
    kind: "linux",
    source: "ssh",
    enabled: true,
    sshHost: "",
    sshPort: 22,
    sshUser: "",
    sshPassword: "",
    sshScript: "",
  };
}

function keyFor(row: HostSettingsRow, index: number): string {
  return row.id || `draft-${index}`;
}

export function initHostsSettings(options: {
  api: HostsSettingsApi;
  setFoot: (msg: string) => void;
}): {
  open: () => Promise<void>;
  close: () => void;
  toggle: () => Promise<void>;
  isOpen: () => boolean;
} {
  const view = document.getElementById("settings-view");
  const shell = document.getElementById("shell");
  const listEl = document.getElementById("settings-host-list");
  const form = document.getElementById("settings-host-form") as HTMLFormElement | null;
  const titleEl = document.getElementById("settings-detail-title");
  const toggleBtn = document.getElementById("hosts-toggle");

  let rows: HostSettingsRow[] = [];
  let selectedKey = "";
  let openState = false;

  function field<T extends HTMLInputElement | HTMLSelectElement>(name: string): T | null {
    return (form?.elements.namedItem(name) as T | null) ?? null;
  }

  function selectedIndex(): number {
    return rows.findIndex((row, i) => keyFor(row, i) === selectedKey);
  }

  function syncFormDisabled(local: boolean): void {
    for (const name of ["kind", "sshHost", "sshPort", "sshUser", "sshPassword"]) {
      const el = field(name);
      if (el) el.disabled = local;
    }
  }

  function writeForm(row: HostSettingsRow | null): void {
    if (!form) return;
    if (!row) {
      form.reset();
      if (titleEl) titleEl.textContent = "Select a host";
      syncFormDisabled(true);
      return;
    }
    if (titleEl) {
      titleEl.textContent = row.source === "local" ? `${row.label} (local)` : row.label;
    }
    const label = field<HTMLInputElement>("label");
    const kind = field<HTMLSelectElement>("kind");
    const sshHost = field<HTMLInputElement>("sshHost");
    const sshPort = field<HTMLInputElement>("sshPort");
    const sshUser = field<HTMLInputElement>("sshUser");
    const sshPassword = field<HTMLInputElement>("sshPassword");
    const enabled = field<HTMLInputElement>("enabled");
    if (label) label.value = row.label;
    if (kind) kind.value = row.kind;
    if (sshHost) sshHost.value = row.sshHost;
    if (sshPort) sshPort.value = String(row.sshPort || 22);
    if (sshUser) sshUser.value = row.sshUser;
    if (sshPassword) sshPassword.value = row.sshPassword;
    if (enabled) enabled.checked = row.enabled;
    syncFormDisabled(row.source === "local");
  }

  function readFormIntoSelected(): void {
    const idx = selectedIndex();
    if (idx < 0 || !form) return;
    const row = rows[idx];
    row.label = String(field<HTMLInputElement>("label")?.value || "").trim() || row.label;
    row.kind = field<HTMLSelectElement>("kind")?.value === "linux" ? "linux" : "darwin";
    row.enabled = Boolean(field<HTMLInputElement>("enabled")?.checked);
    if (row.source !== "local") {
      row.sshHost = String(field<HTMLInputElement>("sshHost")?.value || "").trim();
      row.sshPort = Number(field<HTMLInputElement>("sshPort")?.value) || 22;
      row.sshUser = String(field<HTMLInputElement>("sshUser")?.value || "").trim();
      row.sshPassword = String(field<HTMLInputElement>("sshPassword")?.value || "");
    }
    selectedKey = keyFor(row, idx);
  }

  function paintList(): void {
    if (!listEl) return;
    listEl.innerHTML = rows
      .map((row, index) => {
        const key = keyFor(row, index);
        const active = key === selectedKey ? " is-active" : "";
        const off = row.enabled ? "" : " is-disabled";
        const meta =
          row.source === "local"
            ? "local"
            : escapeHtml(row.sshHost || "no host");
        return `
          <button type="button" class="settings-host-item${active}${off}" data-key="${escapeHtml(key)}">
            <span class="settings-host-name">${escapeHtml(row.label || "untitled")}</span>
            <span class="settings-host-meta">${meta}</span>
            <span class="settings-host-state">${row.enabled ? "on" : "off"}</span>
          </button>
        `;
      })
      .join("");
  }

  function selectKey(key: string): void {
    readFormIntoSelected();
    selectedKey = key;
    const idx = selectedIndex();
    writeForm(idx >= 0 ? rows[idx] : null);
    paintList();
  }

  async function setOpen(next: boolean): Promise<void> {
    openState = next;
    view?.classList.toggle("is-open", next);
    if (next) view?.removeAttribute("hidden");
    else view?.setAttribute("hidden", "");
    shell?.classList.toggle("is-settings", next);
    toggleBtn?.classList.toggle("chip-active", next);
    toggleBtn?.setAttribute("aria-pressed", String(next));
    if (options.api.setSettingsLayout) {
      await options.api.setSettingsLayout(next);
    }
  }

  async function open(): Promise<void> {
    options.setFoot("loading hosts...");
    await setOpen(true);
    try {
      rows = await options.api.getHostSettings();
      selectedKey = rows.length ? keyFor(rows[0], 0) : "";
      writeForm(rows[0] || null);
      paintList();
      options.setFoot("hosts settings");
    } catch {
      rows = [];
      selectedKey = "";
      writeForm(null);
      paintList();
      options.setFoot("hosts load failed");
    }
  }

  async function close(): Promise<void> {
    readFormIntoSelected();
    await setOpen(false);
    options.setFoot("hosts closed");
  }

  async function toggle(): Promise<void> {
    if (openState) await close();
    else await open();
  }

  listEl?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const item = target?.closest?.(".settings-host-item") as HTMLButtonElement | null;
    if (!item?.dataset.key) return;
    selectKey(item.dataset.key);
  });

  form?.addEventListener("input", () => {
    readFormIntoSelected();
    paintList();
  });
  form?.addEventListener("change", () => {
    readFormIntoSelected();
    paintList();
  });

  document.getElementById("hosts-add")?.addEventListener("click", () => {
    readFormIntoSelected();
    const draft = blankRemote();
    rows.push(draft);
    selectedKey = keyFor(draft, rows.length - 1);
    writeForm(draft);
    paintList();
    field<HTMLInputElement>("label")?.focus();
    options.setFoot("new host - fill fields then save");
  });

  document.getElementById("hosts-duplicate")?.addEventListener("click", () => {
    readFormIntoSelected();
    const idx = selectedIndex();
    if (idx < 0) {
      options.setFoot("select a host to duplicate");
      return;
    }
    const source = rows[idx];
    const draft: HostSettingsRow = {
      ...source,
      id: "",
      label: `${source.label}-copy`,
      source: "ssh",
      enabled: true,
      sshHost: "",
      sshScript: "",
      sshPort: source.sshPort || 22,
      sshUser: source.sshUser,
      sshPassword: source.sshPassword,
      kind: source.kind,
    };
    rows.push(draft);
    selectedKey = keyFor(draft, rows.length - 1);
    writeForm(draft);
    paintList();
    field<HTMLInputElement>("sshHost")?.focus();
    options.setFoot("duplicated - set hostname then save");
  });

  document.getElementById("hosts-save")?.addEventListener("click", () => {
    readFormIntoSelected();
    options.setFoot("saving hosts...");
    void options.api
      .saveHostSettings(rows)
      .then((saved) => {
        rows = saved;
        if (!rows.some((row, i) => keyFor(row, i) === selectedKey)) {
          selectedKey = rows.length ? keyFor(rows[0], 0) : "";
        }
        const idx = selectedIndex();
        writeForm(idx >= 0 ? rows[idx] : null);
        paintList();
        options.setFoot("hosts saved");
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        options.setFoot(`hosts save failed: ${message.slice(0, 80)}`);
      });
  });

  document.getElementById("hosts-close")?.addEventListener("click", () => {
    void close();
  });

  toggleBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    void toggle();
  });

  return {
    open,
    close: () => {
      void close();
    },
    toggle,
    isOpen: () => openState,
  };
}
