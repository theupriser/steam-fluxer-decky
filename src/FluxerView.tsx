import { call } from "@decky/api";
import { Focusable, ModalRoot, NavEntryPositionPreferences, Router, showModal } from "@decky/ui";
import { FC, useEffect, useRef, useState } from "react";
import {
  FaArrowLeft, FaChevronDown, FaCog, FaDesktop, FaMicrophone, FaMicrophoneSlash, FaPhone, FaPhoneSlash,
  FaComment, FaServer, FaUser, FaUserFriends, FaVolumeMute, FaVolumeUp,
} from "react-icons/fa";
import { ChatView } from "./ChatView";
import { FluxerLogo } from "./FluxerLogo";
import { FriendsHub } from "./FriendsHub";
import { SettingsPanel } from "./SettingsPanel";
import { SetupWizard } from "./SetupWizard";
import { refreshState, useFluxerState } from "./state";
import {
  Avatar, DANGER, FULL_BLEED, IconBtn, ONLINE, SIDEBAR_FIT, SidebarItem, Tile, chromeHideMarkerRef, pinTop, statusText,
} from "./ui";

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

// Keeps the running game from receiving the view's button presses. Steam does
// this itself for its own menus by marking an overlay as active for the game;
// the view is a modal in the main window, which Steam does not count as one.
const OVERLAY_HIDDEN = 0;
const OVERLAY_ACTIVE = 2;
const setGameOverlay = (state: number) => {
  try {
    const gameid = (Router as any).MainRunningApp?.gameid;
    if (gameid) (window as any).SteamClient.Overlay.SetOverlayState(String(gameid), state);
  } catch (e) {
    console.log("Fluxer: could not set the overlay state", e);
  }
};

// State of the one open view. If Steam never reports the modal as closed, the
// next request closes the stale one and opens a fresh view: a missed close
// must never lock the view out.
let current: { close: () => void; finish: () => void } | null = null;

/** Closes the view if it is open (plugin unload), releasing the game's input. */
export const closeFluxerView = () => {
  if (!current) return;
  try { current.close(); } catch { /* already gone */ }
  current.finish();
};

/** Opens the Fluxer view from anywhere (QAM panel, Steam main menu). */
export const openFluxerView = () => {
  if (open && current) {
    console.log("Fluxer: a view is still marked open, closing it and opening a fresh one");
    try { current.close(); } catch { /* already gone */ }
    current.finish();
  }
  open = true;
  console.log("Fluxer: opening the view");
  let unwatch = () => {};
  let keepOverlay: ReturnType<typeof setInterval> | undefined;
  let menuWinRef: Window | null = null;
  const finish = () => {
    unwatch();
    unwatch = () => {};
    if (keepOverlay) {
      clearInterval(keepOverlay);
      keepOverlay = undefined;
      // Hand input back to the game, unless Steam's own menu is up (it owns the
      // overlay state then and releases it itself).
      if (!menuWinRef || menuWinRef.document.hidden) setGameOverlay(OVERLAY_HIDDEN);
    }
    if (current === handle) {
      current = null;
      open = false;
    }
  };
  const handle = { close: () => {}, finish };
  current = handle;
  try {
    const menuWin = getMainMenuWindow();
    menuWinRef = menuWin;
    const openedAt = Date.now();
    const modal = showModal(<FluxerModal closeModal={() => { modal.Close(); finish(); }} />, undefined, {
      fnOnClose: () => {
        console.log("Fluxer: view closed");
        finish();
      },
    } as any);
    handle.close = () => modal.Close();
    // Steam may reset the state when the menu that opened the view closes, so
    // it is asserted again for as long as the view is open.
    setGameOverlay(OVERLAY_ACTIVE);
    keepOverlay = setInterval(() => setGameOverlay(OVERLAY_ACTIVE), 1000);
    // The Steam button opens the main menu ON TOP of the view: close the view so
    // the menu is shown alone; a second press then returns to the game. Only a
    // real hidden -> visible change counts, and not while the menu that opened
    // the view is still closing itself (it flips visibility right after).
    if (menuWin) {
      let wasHidden = menuWin.document.hidden;
      const onVisible = () => {
        const hidden = menuWin.document.hidden;
        const revealed = wasHidden && !hidden;
        wasHidden = hidden;
        if (revealed && Date.now() - openedAt > 700) {
          console.log("Fluxer: Steam menu opened, closing the view");
          modal.Close();
          finish();
        }
      };
      menuWin.addEventListener("visibilitychange", onVisible);
      unwatch = () => menuWin.removeEventListener("visibilitychange", onVisible);
    }
  } catch (e) {
    console.log("Fluxer: could not open the view", e);
    finish();
  }
};

type Result = { ok: boolean; error?: string };
type Mode = "dms" | "friends" | "servers" | "settings" | "accounts";
type Chat = { channelId: string; name: string; sub: string };

const byInstance = <T extends { instanceHost: string | null }>(accounts: T[]) => {
  const groups = new Map<string, T[]>();
  for (const a of accounts) {
    const host = a.instanceHost || "unknown instance";
    groups.set(host, [...(groups.get(host) || []), a]);
  }
  return [...groups.entries()];
};

const ServerIcon: FC<{ name: string; src?: string | null }> = ({ name, src }) => {
  const [failed, setFailed] = useState(false);
  const box = { width: 38, height: 38, borderRadius: 10, flexShrink: 0 };
  return src && !failed ? (
    <img src={src} width={38} height={38} onError={() => setFailed(true)} style={{ ...box, objectFit: "cover" }} />
  ) : (
    <span style={{ ...box, background: "linear-gradient(135deg,#4641d9,#8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>
      {name[0]?.toUpperCase()}
    </span>
  );
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

// A question from Fluxer (for example "you're already connected to this voice
// channel from another device"). Fluxer shows it in its hidden window, so it is
// shown here as a dialog over the view, like in the real app.
const PromptModal: FC<{ closeModal?: () => void }> = ({ closeModal }) => {
  const state = useFluxerState();
  const prompt = state?.prompt;
  const [busy, setBusy] = useState(false);
  const answer = async (index: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await call("answer_prompt", index);
    } catch { /* the question may already be gone */ }
    await refreshState();
    setTimeout(refreshState, 800);
    setBusy(false);
  };
  // B answers with the last option, which is the "do nothing" choice.
  const cancel = () => { if (prompt) answer(prompt.buttons.length - 1); else closeModal?.(); };
  return (
    <ModalRootAny onCancel={cancel} closeModal={closeModal}>
      <div style={{ fontSize: 19, fontWeight: 800, marginBottom: 8 }}>{prompt?.title || "Fluxer asks"}</div>
      <div style={{ lineHeight: 1.5, opacity: 0.85, marginBottom: 16 }}>{prompt?.text}</div>
      <Focusable flow-children="column" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {(prompt?.buttons || []).map((b, i) => (
          <Tile key={b.index} flex active={i === 0} disabled={busy} onClick={() => answer(b.index)}>
            <span style={{ fontWeight: 650 }}>{b.label}</span>
          </Tile>
        ))}
      </Focusable>
    </ModalRootAny>
  );
};

export const FluxerModal: FC<{ closeModal: () => void }> = ({ closeModal }) => {
  const state = useFluxerState();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>("dms");
  // Second levels: an open conversation, or the server whose channels are shown.
  const [chat, setChat] = useState<Chat | null>(null);
  const [serverId, setServerId] = useState<string | null>(null);

  const needsSetup = !state?.logged_in;
  const voice = state?.voice;
  const inCall = !!voice?.channelId;
  const active = state?.accounts.find((a) => a.accountKey === state.active_account) || state?.accounts[0];
  const server = (state?.guilds || []).find((g) => g.id === serverId) || null;

  // Open the question dialog when Fluxer asks one, close it once it is answered.
  const promptModal = useRef<{ Close: () => void } | null>(null);
  const hasPrompt = !!state?.prompt;
  useEffect(() => {
    if (hasPrompt && !promptModal.current) {
      const m = showModal(<PromptModal closeModal={() => m.Close()} />, undefined, {
        fnOnClose: () => { promptModal.current = null; },
      } as any);
      promptModal.current = m;
    } else if (!hasPrompt && promptModal.current) {
      promptModal.current.Close();
      promptModal.current = null;
    }
  }, [hasPrompt]);
  useEffect(() => () => { promptModal.current?.Close(); promptModal.current = null; }, []);

  const run = async (method: string, ...args: string[]): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setNote(null);
    let ok = false;
    try {
      const res = await call<string[], Result>(method, ...args);
      ok = !!res.ok;
      if (!res.ok) setNote(res.error || "Something went wrong.");
    } catch (e: any) {
      setNote(String(e?.message || e));
    }
    await refreshState();
    setBusy(false);
    return ok;
  };
  // The share captures what gamescope shows: with this view open that would be
  // the view itself. After starting, close it so the game is what gets shared.
  const toggleStream = async () => {
    const starting = !voice?.streaming;
    const ok = await run("toggle_stream");
    if (ok && starting) closeModal();
  };

  const pick = (m: Mode) => { setChat(null); setServerId(null); setMode(m); };
  // B goes up one level (chat or server -> its list) before closing the view.
  const onCancel = () => {
    if (chat) setChat(null);
    else if (mode === "servers" && server) setServerId(null);
    else if (mode === "accounts") pick("dms");
    else closeModal();
  };
  const openChat = (channelId: string, name: string) => { setMode("dms"); setChat({ channelId, name, sub: "Private message" }); };
  // A server's text channel opens in place: B returns to that server's page.
  const openChannel = (channelId: string, name: string) => setChat({ channelId, name: `#${name}`, sub: server?.name || "Text channel" });
  const joinCall = async (channelId: string) => {
    await run("join_voice", channelId);
    // A question from Fluxer (already connected elsewhere) can appear a moment later.
    setTimeout(refreshState, 600);
    setTimeout(refreshState, 1500);
    setTimeout(refreshState, 3000);
  };

  const titles: Record<Mode, [string, string]> = {
    dms: ["Direct messages", "Your conversations"],
    friends: ["Friends", `${(state?.friends || []).length} friends`],
    servers: server ? [server.name || server.id, "Channels"] : ["Servers", `${(state?.guilds || []).length} servers`],
    settings: ["Settings", "Fluxer app and window"],
    accounts: ["Accounts", "Switch between your accounts"],
  };
  const head: [string, string] = needsSetup && mode !== "settings" ? ["Set up Fluxer", "Install and sign in"] : chat ? [chat.name, chat.sub] : titles[mode];
  const scroller = { flex: 1, minHeight: 0, overflowY: "auto" as const, padding: "4px 8px 4px 4px" };
  const column = { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" as const };

  const body = needsSetup && mode !== "settings" ? (
    <SetupWizard state={state} />
  ) : chat ? (
    <div style={column}>
      <Focusable flow-children="row" style={{ flexShrink: 0, display: "flex", marginBottom: 8 }}>
        <Tile onClick={() => setChat(null)}>
          <FaArrowLeft />
          <span style={{ fontWeight: 650 }}>Back</span>
        </Tile>
      </Focusable>
      <ChatView key={chat.channelId} channelId={chat.channelId} />
    </div>
  ) : mode === "friends" ? (
    <div style={column}><FriendsHub onChat={openChat} onCall={joinCall} /></div>
  ) : mode === "settings" ? (
    <SettingsPanel state={state} />
  ) : mode === "dms" ? (
    <Focusable flow-children="column" style={scroller}>
      {(state?.dms || []).length === 0 && <div style={{ opacity: 0.6 }}>No conversations.</div>}
      {(state?.dms || []).map((d) => {
        const other = d.recipients[0];
        const here = d.id === voice?.channelId;
        return (
          <Focusable key={d.id} flow-children="row" style={{ display: "flex", gap: 6, marginBottom: 5 }}>
            <Tile flex onClick={() => openChat(d.id, d.name)}>
              <Avatar name={d.name} src={d.recipients.length === 1 ? other?.avatar : null} status={d.recipients.length === 1 ? other?.status : undefined} />
              <Name sub={here ? "In call" : d.recipients.length === 1 ? statusText(other?.status || "offline") : `${d.recipients.length + 1} members`} subColor={here ? ONLINE : undefined}>{d.name}</Name>
            </Tile>
            <Tile active={here} disabled={busy || here} onClick={() => joinCall(d.id)}>
              <span style={{ width: 104, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, fontWeight: 650 }}>
                <FaPhone /> {here ? "In call" : "Call"}
              </span>
            </Tile>
          </Focusable>
        );
      })}
    </Focusable>
  ) : mode === "servers" && !server ? (
    <Focusable flow-children="column" style={scroller}>
      {(state?.guilds || []).length === 0 && <div style={{ opacity: 0.6 }}>No servers found.</div>}
      {(state?.guilds || []).map((g) => {
        const here = g.voiceChannels.some((c) => c.id === voice?.channelId);
        return (
          <div key={g.id} style={{ marginBottom: 5 }}>
            <Tile flex active={here} onClick={() => setServerId(g.id)}>
              <ServerIcon name={g.name || "?"} src={g.icon} />
              <Name sub={here ? "You are in a call here" : `${g.textChannels.length} text · ${g.voiceChannels.length} voice`} subColor={here ? ONLINE : undefined}>{g.name || g.id}</Name>
              <span style={{ opacity: 0.5 }}>›</span>
            </Tile>
          </div>
        );
      })}
    </Focusable>
  ) : mode === "servers" && server ? (
    <Focusable flow-children="column" style={scroller}>
      {server.textChannels.length === 0 && server.voiceChannels.length === 0 && <div style={{ opacity: 0.6 }}>No channels.</div>}
      {server.textChannels.length > 0 && <Label>TEXT CHANNELS</Label>}
      {server.textChannels.map((c) => (
        <div key={c.id} style={{ marginBottom: 5 }}>
          <Tile flex onClick={() => openChannel(c.id, c.name)}>
            <span style={{ opacity: 0.7, flexShrink: 0, width: 16, textAlign: "center", fontWeight: 700 }}>#</span>
            <Name sub={c.category || undefined}>{c.name}</Name>
            <FaComment style={{ opacity: 0.7 }} />
          </Tile>
        </div>
      ))}
      {server.voiceChannels.length > 0 && <Label>VOICE CHANNELS</Label>}
      {server.voiceChannels.map((c) => {
        const here = c.id === voice?.channelId;
        return (
          <div key={c.id} style={{ marginBottom: 5 }}>
            <Tile flex active={here} disabled={busy || here} onClick={() => joinCall(c.id)}>
              <FaVolumeUp style={{ opacity: 0.7, flexShrink: 0 }} />
              <Name sub={here ? "Connected" : c.category || undefined} subColor={here ? ONLINE : undefined}>{c.name}</Name>
              <span style={{ width: 90, textAlign: "center", fontWeight: 650 }}>{here ? "In call" : "Join"}</span>
            </Tile>
          </div>
        );
      })}
    </Focusable>
  ) : (
    <Focusable flow-children="column" style={scroller}>
      {byInstance(state?.accounts || []).map(([host, accounts]) => (
        <div key={host}>
          <Label>{host.toUpperCase()}</Label>
          {accounts.map((a) => {
            const isActive = a.accountKey === state?.active_account;
            return (
              <div key={a.accountKey} style={{ marginBottom: 5 }}>
                <Tile flex active={isActive} disabled={busy || !a.isValid} onClick={() => (isActive ? undefined : run("switch_account", a.accountKey))}>
                  <Avatar name={a.displayName || a.userId || "?"} src={a.avatar} />
                  <Name sub={!a.isValid ? "Login expired" : isActive ? "Active" : undefined} subColor={!a.isValid ? DANGER : isActive ? ONLINE : undefined}>
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
              <FluxerLogo size={32} /> Fluxer
            </div>
            <div style={{ fontSize: 11, letterSpacing: 0.8, fontWeight: 700, opacity: 0.48, padding: "0 10px 7px" }}>NAVIGATION</div>
            <SidebarItem active={mode === "dms"} icon={<FaUser />} label="Direct messages" onPick={() => pick("dms")} />
            <SidebarItem active={mode === "friends"} icon={<FaUserFriends />} label="Friends" onPick={() => pick("friends")} />
            <SidebarItem active={mode === "servers"} icon={<FaServer />} label="Servers" onPick={() => pick("servers")} />
            <SidebarItem active={mode === "settings"} icon={<FaCog />} label="Settings" onPick={() => pick("settings")} />
            <div className="fx-xv-foot" style={{ marginTop: "auto", paddingTop: 12 }}>
              {/* Like the Fluxer app: the call you are in, with its controls,
                  sits above your account at the bottom of the sidebar. */}
              {inCall && (
                <div style={{ padding: "10px 10px 8px", marginBottom: 8, borderRadius: 10, background: "rgba(0,0,0,.28)", border: "1px solid rgba(255,255,255,.08)" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: voice?.connected ? ONLINE : "#f0b232" }}>
                    {voice?.connected ? "Voice connected" : "Connecting..."}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 650, margin: "2px 0 8px", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                    {voice?.channelName || "Call"}
                  </div>
                  <Focusable flow-children="row" style={{ display: "flex", gap: 6 }}>
                    <IconBtn on={!!voice?.selfMute} disabled={busy} onClick={() => run("toggle_mute")}>
                      {voice?.selfMute ? <FaMicrophoneSlash /> : <FaMicrophone />}
                    </IconBtn>
                    <IconBtn on={!!voice?.selfDeaf} disabled={busy} onClick={() => run("toggle_deafen")}>
                      {voice?.selfDeaf ? <FaVolumeMute /> : <FaVolumeUp />}
                    </IconBtn>
                    <IconBtn on={!!voice?.streaming} disabled={busy} onClick={toggleStream}>
                      <FaDesktop />
                    </IconBtn>
                    <IconBtn danger disabled={busy} onClick={() => run("leave_voice")}>
                      <FaPhoneSlash />
                    </IconBtn>
                  </Focusable>
                </div>
              )}
              {/* A switcher only makes sense with several accounts; with one it
                  is just who you are, not a control. */}
              {(state?.accounts.length ?? 0) > 1 ? (
                <SidebarItem
                  active={mode === "accounts"}
                  icon={<Avatar name={active?.displayName || "?"} src={active?.avatar} size={28} />}
                  label={active?.displayName || "Account"}
                  badge={<FaChevronDown style={{ opacity: 0.5 }} />}
                  onPick={() => pick("accounts")}
                />
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", marginBottom: 5 }}>
                  <Avatar name={active?.displayName || "?"} src={active?.avatar} size={28} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "block", fontWeight: 600, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{active?.displayName || "Account"}</span>
                    {active?.instanceHost && <span style={{ display: "block", fontSize: 11, opacity: 0.5 }}>{active.instanceHost}</span>}
                  </span>
                </div>
              )}
              <SidebarItem active={false} icon={<FaArrowLeft />} label="Back" badge={<span style={{ fontSize: 11, opacity: 0.5 }}>B</span>} onPick={onCancel} />
            </div>
          </Focusable>
          <Focusable
            flow-children="column"
            navEntryPreferPosition={NavEntryPositionPreferences.FIRST}
            onScroll={pinTop}
            style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column", padding: "24px 28px 18px" }}
          >
            <Title main={head[0]} sub={head[1]} />
            {note && <div style={{ color: "#ff6b6b", marginBottom: 8 }}>{note}</div>}
            {body}
          </Focusable>
        </Focusable>
      </div>
    </ModalRootAny>
  );
};
