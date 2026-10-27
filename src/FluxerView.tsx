import { call } from "@decky/api";
import { DialogButton, Focusable, ModalRoot, showModal } from "@decky/ui";
import { FC, useState } from "react";
import { FluxerAccount, refreshState, useFluxerState } from "./state";

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

const byInstance = (accounts: FluxerAccount[]) => {
  const groups = new Map<string, FluxerAccount[]>();
  for (const a of accounts) {
    const host = a.instanceHost || "unknown instance";
    groups.set(host, [...(groups.get(host) || []), a]);
  }
  return [...groups.entries()];
};

const Section: FC<{ title: string }> = ({ title, children }) => (
  <div style={{ marginBottom: 18 }}>
    <div style={{ opacity: 0.7, fontSize: 13, marginBottom: 6 }}>{title}</div>
    {children}
  </div>
);

const FluxerModal: FC<{ closeModal: () => void }> = ({ closeModal }) => {
  const state = useFluxerState();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (method: string, ...args: string[]) => {
    setBusy(true);
    setNote(null);
    try {
      const res = await call<string[], Result>(method, ...args);
      if (!res.ok) setNote(res.error || "Something went wrong.");
    } catch (e: any) {
      setNote(String(e?.message || e));
    }
    await refreshState();
    setBusy(false);
  };

  const voice = state?.voice;
  const inCall = !!voice?.channelId;

  return (
    <ModalRoot onCancel={closeModal} closeModal={closeModal}>
      <h2 style={{ marginTop: 0 }}>Fluxer</h2>
      {!state?.ready && <div>Fluxer is not running.</div>}

      {state?.ready && inCall && (
        <Section title={voice?.connected ? "In voice" : "Connecting..."}>
          <div style={{ fontSize: 16, marginBottom: 8 }}>{voice?.channelName || voice?.channelId}</div>
          <Focusable style={{ display: "flex", gap: 8 }} flow-children="row">
            <DialogButton disabled={busy} onClick={() => run("toggle_mute")}>
              {voice?.selfMute ? "Unmute" : "Mute"}
            </DialogButton>
            <DialogButton disabled={busy} onClick={() => run("toggle_deafen")}>
              {voice?.selfDeaf ? "Undeafen" : "Deafen"}
            </DialogButton>
            <DialogButton disabled={busy} onClick={() => run("leave_voice")}>
              Leave
            </DialogButton>
          </Focusable>
        </Section>
      )}

      {state?.ready && (state.guilds || []).map((g) => (
        <Section key={g.id} title={g.name || g.id}>
          <Focusable style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {g.voiceChannels.map((c) => (
              <DialogButton
                key={c.id}
                disabled={busy || c.id === voice?.channelId}
                onClick={() => run("join_voice", c.id)}
              >
                {c.name}{c.id === voice?.channelId ? "  (connected)" : ""}
              </DialogButton>
            ))}
          </Focusable>
        </Section>
      ))}

      {state?.ready && state.accounts.length > 0 && (
        <Section title="Accounts">
          {byInstance(state.accounts).map(([host, accounts]) => (
            <div key={host} style={{ marginBottom: 10 }}>
              <div style={{ opacity: 0.6, fontSize: 12, marginBottom: 4 }}>{host}</div>
              <Focusable style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {accounts.map((a) => (
                  <DialogButton
                    key={a.accountKey}
                    disabled={busy || !a.isValid || a.accountKey === state.active_account}
                    onClick={() => run("switch_account", a.accountKey)}
                  >
                    {a.displayName || a.userId}
                    {a.accountKey === state.active_account ? "  (active)" : ""}
                    {!a.isValid ? "  (login expired)" : ""}
                  </DialogButton>
                ))}
              </Focusable>
            </div>
          ))}
        </Section>
      )}

      {note && <div style={{ color: "#ff6b6b", marginBottom: 8 }}>{note}</div>}
      <DialogButton onClick={closeModal}>Close</DialogButton>
    </ModalRoot>
  );
};
