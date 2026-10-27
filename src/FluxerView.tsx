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
  const modal = showModal(
    <FluxerModal
      closeModal={() => modal.Close()}
    />,
    undefined,
    { fnOnClose: () => { unwatch(); open = false; } } as any
  );
  // The Steam button opens the main menu ON TOP of the view: close the view so
  // the menu is shown alone; a second press then returns to the game.
  if (menuWin) {
    const onVisible = () => { if (!menuWin.document.hidden) modal.Close(); };
    menuWin.addEventListener("visibilitychange", onVisible);
    unwatch = () => menuWin.removeEventListener("visibilitychange", onVisible);
  }
};

const byInstance = (accounts: FluxerAccount[]) => {
  const groups = new Map<string, FluxerAccount[]>();
  for (const a of accounts) {
    const host = a.instanceHost || "unknown instance";
    groups.set(host, [...(groups.get(host) || []), a]);
  }
  return [...groups.entries()];
};

const FluxerModal: FC<{ closeModal: () => void }> = ({ closeModal }) => {
  const state = useFluxerState();
  const [note, setNote] = useState<string | null>(null);

  const switchTo = async (key: string) => {
    const res = await call<[string], { ok: boolean; error?: string }>("switch_account", key);
    setNote(res.ok ? null : `Switching accounts is not implemented yet (${res.error}).`);
    refreshState();
  };

  return (
    <ModalRoot onCancel={closeModal} closeModal={closeModal}>
      <h2 style={{ marginTop: 0 }}>Fluxer</h2>
      {!state?.ready && <div>Fluxer is not running.</div>}
      {state?.ready &&
        byInstance(state.accounts).map(([host, accounts]) => (
          <div key={host} style={{ marginBottom: 16 }}>
            <div style={{ opacity: 0.7, fontSize: 13, marginBottom: 6 }}>{host}</div>
            <Focusable style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {accounts.map((a) => (
                <DialogButton key={a.accountKey} disabled={!a.isValid} onClick={() => switchTo(a.accountKey)}>
                  {a.displayName || a.userId}
                  {a.accountKey === state.active_account_guess ? "  (active)" : ""}
                  {!a.isValid ? "  (login expired)" : ""}
                </DialogButton>
              ))}
            </Focusable>
          </div>
        ))}
      {note && <div style={{ color: "#ff6b6b", marginTop: 8 }}>{note}</div>}
      <DialogButton onClick={closeModal} style={{ marginTop: 12 }}>
        Close
      </DialogButton>
    </ModalRoot>
  );
};
