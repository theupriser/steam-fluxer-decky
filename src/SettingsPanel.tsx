import { call } from "@decky/api";
import { Focusable } from "@decky/ui";
import { FC, useEffect, useState } from "react";
import { FluxerState, refreshState } from "./state";
import { DANGER, ONLINE, Tile } from "./ui";

interface WindowSettings {
  showTrayIcon: boolean;
  closeToTray: boolean;
  startMinimized: boolean;
}

const Heading: FC = ({ children }) => (
  <div style={{ fontSize: 13, fontWeight: 600, margin: "14px 4px 8px" }}>{children}</div>
);

const Switch: FC<{ label: string; hint: string; value: boolean; disabled?: boolean; onChange: (v: boolean) => void }> = ({
  label,
  hint,
  value,
  disabled,
  onChange,
}) => (
  <div style={{ marginBottom: 5 }}>
    <Tile flex disabled={disabled} onClick={() => onChange(!value)}>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", fontWeight: 650 }}>{label}</span>
        <span style={{ display: "block", marginTop: 2, fontSize: 11, opacity: 0.58 }}>{hint}</span>
      </span>
      <span
        style={{
          width: 46,
          height: 24,
          borderRadius: 12,
          background: value ? ONLINE : "rgba(255,255,255,.18)",
          position: "relative",
          flexShrink: 0,
        }}
      >
        <span style={{ position: "absolute", top: 3, left: value ? 25 : 3, width: 18, height: 18, borderRadius: "50%", background: "#fff", transition: "left .1s" }} />
      </span>
    </Tile>
  </div>
);

/** Fluxer's own settings: app process and the desktop window behaviour. */
export const SettingsPanel: FC<{ state?: FluxerState }> = ({ state }) => {
  const [win, setWin] = useState<WindowSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ready = !!state?.ready;

  const load = () =>
    call<[], WindowSettings>("get_window_settings")
      .then((r) => setWin(r))
      .catch(() => setWin(null));
  useEffect(() => {
    if (ready) load();
  }, [ready]);

  const set = async (patch: Partial<WindowSettings>) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await call<[Partial<WindowSettings>], { ok: boolean; error?: string }>("set_window_settings", patch);
      if (!r.ok) setNote(r.error || "Could not change the setting.");
    } catch (e: any) {
      setNote(String(e?.message || e));
    }
    await load();
    setBusy(false);
  };

  const app = async (method: "start" | "stop") => {
    setBusy(true);
    setNote(null);
    try {
      await call(method);
    } catch (e: any) {
      setNote(String(e?.message || e));
    }
    await refreshState();
    setBusy(false);
  };

  return (
    <Focusable flow-children="column" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 8px 4px 4px" }}>
      <Heading>Fluxer app</Heading>
      <Tile danger={ready} active={!ready} disabled={busy} onClick={() => app(ready ? "stop" : "start")}>
        <span style={{ fontWeight: 650 }}>{busy ? "..." : ready ? "Stop Fluxer" : "Start Fluxer"}</span>
      </Tile>
      <div style={{ fontSize: 11, opacity: 0.55, margin: "6px 4px 0" }}>
        {ready ? "Fluxer runs hidden in the background; this view talks to it." : "Fluxer is not running."}
      </div>

      {ready && win && (
        <>
          <Heading>Window and startup</Heading>
          <Switch label="Start hidden" hint="Launch without showing a window (needed for Game Mode)" value={win.startMinimized} disabled={busy} onChange={(v) => set({ startMinimized: v })} />
          <Switch label="Show tray icon" hint="Required for hidden start" value={win.showTrayIcon} disabled={busy} onChange={(v) => set({ showTrayIcon: v })} />
          <Switch label="Close to tray" hint="Closing the window keeps Fluxer running" value={win.closeToTray} disabled={busy} onChange={(v) => set({ closeToTray: v })} />
        </>
      )}
      {note && <div style={{ color: DANGER, margin: "8px 4px" }}>{note}</div>}
    </Focusable>
  );
};
