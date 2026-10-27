import { call, routerHook } from "@decky/api";
import {
  ButtonItem,
  Navigation,
  PanelSection,
  PanelSectionRow,
  definePlugin,
  staticClasses,
} from "@decky/ui";
import { useEffect } from "react";
import { FaCommentDots } from "react-icons/fa";
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

const Panel = () => {
  const state = useFluxerState();
  const act = async (method: "start" | "stop") => {
    await call(method);
    refreshState();
  };
  const status = !state?.running
    ? "Not running"
    : !state.ready
      ? "Starting..."
      : state.logged_in
        ? `Running (${state.accounts.length} account${state.accounts.length === 1 ? "" : "s"})`
        : "Running, not logged in";
  return (
    <PanelSection title="Fluxer">
      <PanelSectionRow>
        <div>{status}</div>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => act(state?.running ? "stop" : "start")}>
          {state?.running ? "Stop Fluxer" : "Start Fluxer"}
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={!state?.ready} onClick={openFluxerView}>
          Open Fluxer
        </ButtonItem>
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
    icon: <FaCommentDots />,
    onDismount() {
      unpatchMenu();
      routerHook.removeRoute(FLUXER_ROUTE);
    },
  };
});
