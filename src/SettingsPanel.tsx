import { call } from "@decky/api";
import { Focusable } from "@decky/ui";
import { FC, useEffect, useState } from "react";
import { FluxerState, refreshState, setMenuEntryEnabled } from "./state";
import { DANGER, ONLINE, Tile } from "./ui";

interface Diagnostics {
  running: boolean;
  fluxer_version: string | null;
  capabilities: { name: string; ok: boolean; error?: string }[];
  error?: string;
}

interface PluginSettings {
  autostart: boolean;
  menu_entry: boolean;
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

/**
 * Settings that apply in Game Mode. Fluxer's own desktop window options
 * (tray icon, close to tray) are left out: the window is never shown here and
 * the plugin always starts Fluxer hidden.
 */
export const SettingsPanel: FC<{ state?: FluxerState }> = ({ state }) => {
  const [settings, setSettings] = useState<PluginSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ready = !!state?.ready;
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  useEffect(() => {
    if (!ready) {
      setDiag(null);
      return;
    }
    call<[], Diagnostics>("get_diagnostics").then(setDiag).catch(() => setDiag(null));
  }, [ready]);

  const load = () =>
    call<[], PluginSettings>("get_settings")
      .then(setSettings)
      .catch(() => setSettings(null));
  useEffect(() => {
    load();
  }, []);

  const set = async (patch: Partial<PluginSettings>) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await call<[Partial<PluginSettings>], { ok: boolean; error?: string }>("set_settings", patch);
      if (!r.ok) setNote(r.error || "Could not change the setting.");
    } catch (e: any) {
      setNote(String(e?.message || e));
    }
    if (patch.menu_entry !== undefined) setMenuEntryEnabled(patch.menu_entry);
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

      {settings && (
        <>
          <Heading>Startup</Heading>
          <Switch
            label="Start Fluxer with Steam"
            hint="Launch Fluxer hidden when Steam starts, so it is ready from the Steam menu"
            value={settings.autostart}
            disabled={busy}
            onChange={(v) => set({ autostart: v })}
          />
          <Heading>Steam menu</Heading>
          <Switch
            label="Show Fluxer in the Steam menu"
            hint="The entry in the Steam button menu that opens this view"
            value={settings.menu_entry}
            disabled={busy}
            onChange={(v) => set({ menu_entry: v })}
          />
        </>
      )}
      {diag && (
        <>
          <Heading>Compatibility{diag.fluxer_version ? ` · Fluxer ${diag.fluxer_version}` : ""}</Heading>
          {diag.capabilities.length > 0 && diag.capabilities.every((c) => c.ok) ? (
            <div style={{ fontSize: 12, color: ONLINE, margin: "0 4px" }}>All features work with this version of Fluxer.</div>
          ) : (
            <>
              <div style={{ fontSize: 12, opacity: 0.7, margin: "0 4px 6px" }}>
                {diag.error ? `Check failed: ${diag.error}` : "Some features do not work with this version of Fluxer (it may have been updated). The rest keep working."}
              </div>
              {diag.capabilities.filter((c) => !c.ok).map((c) => (
                <div key={c.name} style={{ fontSize: 12, margin: "0 4px 3px", color: DANGER }}>
                  {c.name}: unavailable
                </div>
              ))}
            </>
          )}
        </>
      )}
      {note && <div style={{ color: DANGER, margin: "8px 4px" }}>{note}</div>}
    </Focusable>
  );
};
