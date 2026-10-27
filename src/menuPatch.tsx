// Adds a "Fluxer" entry to Steam's main menu (the Steam button).
// Technique credit: https://github.com/jessebofill/DeckWebBrowser, as adapted in
// https://github.com/Necrosiak/Steamcord (BSD-3-Clause).
import { findInReactTree, getReactRoot } from "@decky/ui";
import { FC, ReactElement } from "react";
import { FluxerLogo } from "./FluxerLogo";
import { useMenuEntry } from "./state";

export const FLUXER_ROUTE = "/fluxer";

interface MenuItemProps {
  route: string;
  label: string;
  active?: boolean;
  icon?: ReactElement;
  onFocus?: () => void;
  onGamepadFocus?: () => void;
}

const tryApplyPatch = (): (() => void) | null => {
  const root = document.getElementById("root");
  const tree = root ? getReactRoot(root as any) : null;
  if (!tree) return null;
  const menuNode = findInReactTree(tree, (n: any) => n?.memoizedProps?.navID == "MainNavMenuContainer");
  if (!menuNode || !menuNode.return?.type) return null;

  const orig = menuNode.return.type;
  let patchedInner: any;
  let origInner: any;
  const menuWrapper = (props: any) => {
    const ret = orig(props);
    const elt = ret?.props?.children?.props?.children?.[0];
    if (!elt?.type) {
      console.log("Fluxer: menu element not at expected location, Valve may have changed it.");
      return ret;
    }
    if (patchedInner) {
      // Re-apply only if React reset the element to the original type.
      if (elt.type === origInner) elt.type = patchedInner;
    } else {
      origInner = elt.type;
      elt.type = function (this: any, ...args: any[]) {
        // Hook: re-render the menu when the setting changes. The entry shows
        // while logged out too: it opens the set-up and login wizard.
        const enabled = useMenuEntry();
        const innerRet = origInner.apply(this, args);
        if (!enabled) return innerRet;

        const isItem = (e: any) =>
          e?.props?.label && (e.props.onGamepadFocus || e.props.onFocus) && e.props.route && e.type?.toString;
        const items = findInReactTree(innerRet, (n: any[]) => Array.isArray(n) && n.some(isItem)) as any[] | null;
        if (!items) {
          console.log("Fluxer: could not find menu items to patch.");
          return innerRet;
        }
        if (items.some((e) => e?.key === "fluxer")) return innerRet;
        const sample = items.find(isItem);
        const indexes = items.flatMap((e, i) => (e && e.$$typeof && e.type !== "div" ? i : []));
        items.splice(
          indexes[Math.min(3, indexes.length - 1)],
          0,
          <MenuItem
            key="fluxer"
            route={FLUXER_ROUTE}
            label="Fluxer"
            active={false}
            onFocus={sample.props.onFocus}
            onGamepadFocus={sample.props.onGamepadFocus}
            useIconAsProp={!!sample.props.icon}
            MenuItemComponent={sample.type}
          />
        );
        return innerRet;
      };
      patchedInner = elt.type;
    }
    return ret;
  };
  menuNode.return.type = menuWrapper;
  if (menuNode.return.alternate) menuNode.return.alternate.type = menuWrapper;

  return () => {
    menuNode.return.type = orig;
    if (menuNode.return.alternate) menuNode.return.alternate.type = orig;
  };
};

export const patchMenu = () => {
  let unpatch: (() => void) | null = null;
  let attempts = 0;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const MAX_ATTEMPTS = 5;
  const attempt = () => {
    if (stopped) return;
    unpatch = tryApplyPatch();
    if (unpatch) {
      console.log(`Fluxer: menu patch applied on attempt ${attempts + 1}`);
    } else if (++attempts < MAX_ATTEMPTS) {
      retry = setTimeout(attempt, 2000);
    } else {
      console.log(`Fluxer: menu patch gave up after ${MAX_ATTEMPTS} attempts.`);
    }
  };
  attempt();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    unpatch?.();
  };
};

const MenuItem: FC<MenuItemProps & { MenuItemComponent: FC<any>; useIconAsProp: boolean }> = ({
  MenuItemComponent,
  useIconAsProp,
  ...props
}) => {
  (props as any)[useIconAsProp ? "icon" : "children"] = <FluxerLogo size={20} mono />;
  return <MenuItemComponent {...props} label="Fluxer" />;
};
