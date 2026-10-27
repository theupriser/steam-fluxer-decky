import { call } from "@decky/api";
import { Focusable, ModalRoot, NavEntryPositionPreferences, showModal } from "@decky/ui";
import { FC, useState } from "react";
import { FaCommentDots, FaMicrophone, FaMicrophoneSlash, FaPhoneSlash, FaServer, FaUserFriends, FaVolumeMute, FaVolumeUp, FaArrowLeft } from "react-icons/fa";
import { FluxerAccount, refreshState, useFluxerState } from "./state";
import { ACCENT, FULL_BLEED, ONLINE, SIDEBAR_FIT, SidebarItem, Tile, chromeHideMarkerRef, pinTop } from "./ui";

const ModalRootAny = ModalRoot as any;

let open = false;

// Window of Steam's main menu (Steam button / Alt+Tab), found through its
// gamepad navigation tree: same technique as useQuickAccessVisible for the QAM.
const getMainMenuWindow = (): Window | null => {
  const nav: any = (window as any).FocusNavController;
  const ctx = nav?.m_ActiveContext || nav?.m_LastActiveContext;
  const tree = ctx?.m_rgGamepadNavigationTrees?.find((t: any) => (t.m_ID || t.id) === "MainNavMenuContainer");
  return (tree?.Root?.Element || tree?.m_Root?.m_element)?.ownerDocument?.defaultView ?? null;
};

/** Opens the Fluxer view from anywhere (QAM panel, Steam main menu). */
export const openFluxerView = () => {
  if (open) return;
  open = true;
  let unwatch = () => {};
  const menuWin = getMainMenuWindow();
  const modal = showModal(<FluxerModal closeModal={() => modal.Close()} />, undefined, {
    fnOnClose: () => { unwatch(); open = false; },
  } as any);
  // The Steam button opens the main menu ON TOP of the view: close the view so
  // the menu is shown alone; a second press then returns to the game.
  if (menuWin) {
    const onVisible = () => { if (!menuWin.document.hidden) modal.Close(); };
    menuWin.addEventListener("visibilitychange", onVisible);
    unwatch = () => menuWin.removeEventListener("visibilitychange", onVisible);
  }
};

type Result = { ok: boolean; error?: string };
type Mode = "voice" | "servers" | "accounts";

const byInstance = (accounts: FluxerAccount[]) => {
  const groups = new Map<string, FluxerAccount[]>();
  for (const a of accounts) {
    const host = a.instanceHost || "unknown instance";
    groups.set(host, [...(groups.get(host) || []), a]);
  }
  return [...groups.entries()];
};

const Title: FC<{ main: string; sub?: string }> = ({ main, sub }) => (
  <div style={{ flexShrink: 0, display: "flex", alignItems: "baseline", gap: 12, borderBottom: "1px solid rgba(255,255,255,.09)", paddingBottom: 15, marginBottom: 14 }}>
    <div style={{ fontSize: 23, fontWeight: 800, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{main}</div>
    {sub && <div style={{ opacity: 0.52, fontSize: 13, flexShrink: 0 }}>{sub}</div>}
  </div>
);

const Label: FC = ({ children }) => (
  <div style={{ fontSize: 11, letterSpacing: 0.8, fontWeight: 700, opacity: 0.48, padding: "10px 4px 7px" }}>{children}</div>
);

const Name: FC<{ sub?: string; subColor?: string }> = ({ children, sub, subColor }) => (
  <span style={{ minWidth: 0, flex: 1 }}>
    <span style={{ display: "block", fontWeight: 650, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{children}</span>
    {sub && <span style={{ display: "block", marginTop: 2, fontSize: 11, opacity: subColor ? 0.9 : 0.58, color: subColor }}>{sub}</span>}
  </span>
);

const FluxerModal: FC<{ closeModal: () => void }> = ({ closeModal }) => {
  const state = useFluxerState();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Mode | null>(null);
  // Second level of Servers: the server whose channels are shown (null = list).
  const [serverId, setServerId] = useState<string | null>(null);

  const voice = state?.voice;
  const inCall = !!voice?.channelId;
  // Until a section is chosen: the call while in one, otherwise the servers.
  const mode: Mode = picked ?? (inCall ? "voice" : "servers");

  const run = async (method: string, ...args: string[]) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await call<string[], Result>(method, ...args);
      if (!res.ok) setNote(res.error || "Something went wrong.");
      else if (method === "join_voice") pick("voice");
    } catch (e: any) {
      setNote(String(e?.message || e));
    }
    await refreshState();
    setBusy(false);
  };

  const server = (state?.guilds || []).find((g) => g.id === serverId) || null;
  const pick = (m: Mode) => { setServerId(null); setPicked(m); };
  // B goes up one level (channels -> server list) before closing the view.
  const onCancel = () => { if (mode === "servers" && server) setServerId(null); else closeModal(); };

  const titles: Record<Mode, [string, string]> = {
    voice: ["Voice", "Current call"],
    servers: server ? [server.name || server.id, "Voice channels"] : ["Servers", `${(state?.guilds || []).length} servers`],
    accounts: ["Accounts", "Switch between your accounts"],
  };
  const scroller = { flex: 1, minHeight: 0, overflowY: "auto" as const, padding: "4px 8px 4px 4px" };

  const body = !state?.ready ? (
    <div style={{ opacity: 0.65 }}>Fluxer is not running. Start it from the Quick Access panel.</div>
  ) : mode === "voice" ? (
    <Focusable flow-children="column" style={scroller}>
      {!inCall ? (
        <div style={{ opacity: 0.62, lineHeight: 1.6 }}>Not in a voice channel. Choose one under Servers.</div>
      ) : (
        <>
          <Label>{voice?.connected ? "CONNECTED" : "CONNECTING..."}</Label>
          <div style={{ fontSize: 17, fontWeight: 700, padding: "0 4px 12px", color: voice?.connected ? ONLINE : undefined }}>
            {voice?.channelName || voice?.channelId}
          </div>
          <Focusable flow-children="row" style={{ display: "flex", gap: 8 }}>
            <Tile active={!!voice?.selfMute} disabled={busy} onClick={() => run("toggle_mute")}>
              {voice?.selfMute ? <FaMicrophoneSlash /> : <FaMicrophone />}
              <span style={{ fontWeight: 650 }}>{voice?.selfMute ? "Unmute" : "Mute"}</span>
            </Tile>
            <Tile active={!!voice?.selfDeaf} disabled={busy} onClick={() => run("toggle_deafen")}>
              {voice?.selfDeaf ? <FaVolumeMute /> : <FaVolumeUp />}
              <span style={{ fontWeight: 650 }}>{voice?.selfDeaf ? "Undeafen" : "Deafen"}</span>
            </Tile>
            <Tile danger disabled={busy} onClick={() => run("leave_voice")}>
              <FaPhoneSlash />
              <span style={{ fontWeight: 650 }}>Leave</span>
            </Tile>
          </Focusable>
        </>
      )}
    </Focusable>
  ) : mode === "servers" && !server ? (
    <Focusable flow-children="column" style={scroller}>
      {(state.guilds || []).length === 0 && <div style={{ opacity: 0.6 }}>No servers found.</div>}
      {(state.guilds || []).map((g) => {
        const here = g.voiceChannels.some((c) => c.id === voice?.channelId);
        return (
          <div key={g.id} style={{ marginBottom: 5 }}>
            <Tile flex active={here} onClick={() => setServerId(g.id)}>
              <span style={{ width: 38, height: 38, borderRadius: 10, background: "linear-gradient(135deg,#4641d9,#8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, flexShrink: 0 }}>
                {(g.name || "?")[0]?.toUpperCase()}
              </span>
              <Name sub={here ? "You are in a call here" : `${g.voiceChannels.length} voice channels`} subColor={here ? ONLINE : undefined}>{g.name || g.id}</Name>
              <span style={{ opacity: 0.5 }}>›</span>
            </Tile>
          </div>
        );
      })}
    </Focusable>
  ) : mode === "servers" && server ? (
    <Focusable flow-children="column" style={scroller}>
      {server.voiceChannels.length === 0 && <div style={{ opacity: 0.6 }}>No voice channels.</div>}
      {server.voiceChannels.map((c) => {
        const here = c.id === voice?.channelId;
        return (
          <div key={c.id} style={{ marginBottom: 5 }}>
            <Tile flex active={here} disabled={busy} onClick={() => (here ? pick("voice") : run("join_voice", c.id))}>
              <FaVolumeUp style={{ opacity: 0.7, flexShrink: 0 }} />
              <Name sub={here ? "Connected" : undefined} subColor={here ? ONLINE : undefined}>{c.name}</Name>
              <span style={{ width: 90, textAlign: "center", fontWeight: 650 }}>{here ? "Open" : "Join"}</span>
            </Tile>
          </div>
        );
      })}
    </Focusable>
  ) : (
    <Focusable flow-children="column" style={scroller}>
      {byInstance(state.accounts).map(([host, accounts]) => (
        <div key={host}>
          <Label>{host.toUpperCase()}</Label>
          {accounts.map((a) => {
            const active = a.accountKey === state.active_account;
            return (
              <div key={a.accountKey} style={{ marginBottom: 5 }}>
                <Tile
                  flex
                  active={active}
                  disabled={busy || !a.isValid}
                  onClick={() => (active ? undefined : run("switch_account", a.accountKey))}
                >
                  <FaUserFriends style={{ opacity: 0.7, flexShrink: 0 }} />
                  <Name
                    sub={!a.isValid ? "Login expired" : active ? "Active" : undefined}
                    subColor={!a.isValid ? "#ed4245" : active ? ONLINE : undefined}
                  >
                    {a.displayName || a.userId}
                  </Name>
                </Tile>
              </div>
            );
          })}
        </div>
      ))}
    </Focusable>
  );

  return (
    <ModalRootAny closeModal={closeModal} onCancel={onCancel} bAllowFullSize>
      <div style={{ display: "contents" }}>
        {/* Marker OUTSIDE the panel: inside, hiding Steam's frame would also
            clear our own background and make the view transparent. */}
        <div ref={chromeHideMarkerRef} style={{ display: "none" }} />
        <Focusable
          flow-children="row"
          onScroll={pinTop}
          style={{ ...FULL_BLEED, height: "80vh", display: "flex", overflow: "hidden", borderRadius: 12, background: "#11151d", boxShadow: "0 22px 60px rgba(0,0,0,.55)" }}
        >
          <Focusable
            flow-children="column"
            className="fx-xv-side"
            style={{ width: 268, flexShrink: 0, padding: 14, overflowX: "hidden", overflowY: "auto", scrollbarWidth: "none", display: "flex", flexDirection: "column", background: "#20252f", borderRight: "1px solid rgba(255,255,255,.08)" } as any}
          >
            <style>{SIDEBAR_FIT}</style>
            <div className="fx-xv-brand" style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px 17px", fontSize: 18, fontWeight: 800, flexShrink: 0 }}>
              <FaCommentDots size={28} color={ACCENT} /> Fluxer
            </div>
            <div style={{ fontSize: 11, letterSpacing: 0.8, fontWeight: 700, opacity: 0.48, padding: "0 10px 7px" }}>NAVIGATION</div>
            <SidebarItem
              active={mode === "voice"}
              icon={<FaMicrophone />}
              label="Voice"
              badge={inCall ? <span style={{ width: 8, height: 8, borderRadius: "50%", background: ONLINE }} /> : undefined}
              onPick={() => pick("voice")}
            />
            <SidebarItem active={mode === "servers"} icon={<FaServer />} label="Servers" onPick={() => pick("servers")} />
            <SidebarItem
              active={mode === "accounts"}
              icon={<FaUserFriends />}
              label="Accounts"
              badge={(state?.accounts.length ?? 0) > 1 ? <span style={{ fontSize: 12, opacity: 0.6 }}>{state?.accounts.length}</span> : undefined}
              onPick={() => pick("accounts")}
            />
            <div className="fx-xv-foot" style={{ marginTop: "auto", paddingTop: 12 }}>
              <SidebarItem active={false} icon={<FaArrowLeft />} label="Back" badge={!server || mode !== "servers" ? <span style={{ fontSize: 11, opacity: 0.5 }}>B</span> : undefined} onPick={closeModal} />
            </div>
          </Focusable>
          <Focusable
            flow-children="column"
            navEntryPreferPosition={NavEntryPositionPreferences.FIRST}
            onScroll={pinTop}
            style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column", padding: "24px 28px 18px" }}
          >
            <Title main={titles[mode][0]} sub={titles[mode][1]} />
            {note && <div style={{ color: "#ff6b6b", marginBottom: 8 }}>{note}</div>}
            {body}
          </Focusable>
        </Focusable>
      </div>
    </ModalRootAny>
  );
};
