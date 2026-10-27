import { call, routerHook } from "@decky/api";
import {
  DialogButton,
  Focusable,
  Navigation,
  PanelSection,
  PanelSectionRow,
  definePlugin,
  staticClasses,
} from "@decky/ui";
import { ReactNode, useEffect, useState } from "react";
import { FaDesktop, FaMicrophone, FaMicrophoneSlash, FaPhoneSlash, FaVolumeMute, FaVolumeUp } from "react-icons/fa";
import { FluxerLogo } from "./FluxerLogo";
import { ONLINE, focusHalo } from "./ui";
import { openFluxerView } from "./FluxerView";
import { FLUXER_ROUTE, patchMenu } from "./menuPatch";
import { refreshState, useFluxerState } from "./state";

// Target of the /fluxer route: go back to the previous page, then open the view.
const FluxerRouteOpener = () => {
  useEffect(() => {
    try { Navigation.NavigateBack(); } catch {}
    const id = setTimeout(openFluxerView, 100);
    return () => clearTimeout(id);
  }, []);
  return null;
};

const DialogBtn = DialogButton as any;

const Card = ({ children }: { children: ReactNode }) => (
  <div style={{ padding: "10px 12px", borderRadius: 10, background: "#20252f", border: "1px solid rgba(255,255,255,.08)", marginBottom: 8 }}>{children}</div>
);

// Same control look as the full view: ring + glow on gamepad focus.
const Btn = ({ children, onClick, disabled, danger, active }: { children: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean; active?: boolean }) => {
  const [focused, setFocused] = useState(false);
  return (
    <DialogBtn
      noFocusRing
      disabled={disabled}
      onClick={onClick}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", minWidth: 0,
        padding: "9px 10px", margin: 0, minHeight: 38, boxSizing: "border-box", color: "#fff", fontWeight: 650,
        background: danger ? "rgba(237,66,69,.35)" : active ? "rgba(35,165,90,.4)" : focused ? "rgba(70,65,217,.45)" : "rgba(255,255,255,.07)",
        ...focusHalo(focused),
      } as any}
    >
      {children}
    </DialogBtn>
  );
};

const Panel = () => {
  const state = useFluxerState();
  const [busy, setBusy] = useState(false);
  const run = async (method: string) => {
    setBusy(true);
    try { await call(method); } catch {}
    await refreshState();
    setBusy(false);
  };
  const voice = state?.voice;
  const inCall = !!voice?.channelId;
  const status = state && state.installed === false
    ? "Not installed"
    : !state?.running
    ? "Not running"
    : !state.ready
      ? "Starting..."
      : state.logged_in
        ? `Running · ${state.accounts.length} account${state.accounts.length === 1 ? "" : "s"}`
        : "Running, not logged in";
  const dot = state?.ready && state.logged_in ? ONLINE : state?.running ? "#f0b232" : "#80848e";
  return (
    <PanelSection>
      <PanelSectionRow>
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <FluxerLogo size={34} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 800 }}>Fluxer</div>
              <div style={{ fontSize: 12, opacity: 0.7, display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot }} />
                {status}
              </div>
            </div>
          </div>
          {inCall && (
            <div style={{ marginTop: 8, fontSize: 12, color: ONLINE, fontWeight: 650, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
              {voice?.connected ? "In call" : "Connecting"}: {voice?.channelName || voice?.channelId}
            </div>
          )}
        </Card>
      </PanelSectionRow>
      <PanelSectionRow>
        <Btn onClick={openFluxerView}>{state?.logged_in ? "Open Fluxer" : "Set up Fluxer"}</Btn>
      </PanelSectionRow>
      {inCall && (
        <PanelSectionRow>
          <Focusable flow-children="row" style={{ display: "flex", gap: 6, width: "100%" }}>
            <Btn active={!!voice?.selfMute} disabled={busy} onClick={() => run("toggle_mute")}>
              {voice?.selfMute ? <FaMicrophoneSlash /> : <FaMicrophone />}
            </Btn>
            <Btn active={!!voice?.selfDeaf} disabled={busy} onClick={() => run("toggle_deafen")}>
              {voice?.selfDeaf ? <FaVolumeMute /> : <FaVolumeUp />}
            </Btn>
            <Btn active={!!voice?.streaming} disabled={busy} onClick={() => run("toggle_stream")}><FaDesktop /></Btn>
            <Btn danger disabled={busy} onClick={() => run("leave_voice")}><FaPhoneSlash /></Btn>
          </Focusable>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <Btn danger={!!state?.running} disabled={busy} onClick={() => run(state?.running ? "stop" : "start")}>
          {state?.running ? "Stop Fluxer" : "Start Fluxer"}
        </Btn>
      </PanelSectionRow>
    </PanelSection>
  );
};

export default definePlugin(() => {
  const unpatchMenu = patchMenu();
  // The Steam menu entry navigates to its route (Steam ignores onActivate on
  // these entries): the route opens the view and goes back.
  routerHook.addRoute(FLUXER_ROUTE, FluxerRouteOpener);

  return {
    name: "Fluxer",
    titleView: <div className={staticClasses.Title}>Fluxer</div>,
    content: <Panel />,
    icon: <FluxerLogo size={20} />,
    onDismount() {
      unpatchMenu();
      routerHook.removeRoute(FLUXER_ROUTE);
    },
  };
});
