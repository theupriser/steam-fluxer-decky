// Visual kit for the full-size view. Adapted from Steamcord (BSD-3-Clause):
// same layout language so both plugins look like one family.
import { Focusable } from "@decky/ui";
import { FC, ReactNode, useState } from "react";

export const ACCENT = "#4641d9";
export const DANGER = "#ed4245";
export const ONLINE = "#23a55a";

// ModalRoot limits its content to ~573 px; break out to viewport width.
// No position:fixed: the dialog has a transform that would collapse it.
export const FULL_BLEED = {
  width: "96vw",
  marginLeft: "calc((100% - 96vw) / 2)",
  boxSizing: "border-box" as const,
};

// Focus ring drawn by us: Steam's native focus paints light bg + dark text.
export const focusHalo = (focused: boolean, scale = 1.02) => ({
  boxShadow: focused ? `0 0 0 2px #fff, 0 0 8px 1px ${ACCENT}` : "none",
  transform: focused ? `scale(${scale})` : "scale(1)",
  transition: "box-shadow .08s ease, transform .08s ease",
  position: "relative" as const,
  zIndex: focused ? 1 : 0,
});

// Lists live in a clipping scroller: ring only, no glow or scale.
export const listHalo = (focused: boolean) => ({
  boxShadow: focused ? "0 0 0 2px #fff" : "none",
  transition: "box-shadow .08s ease",
  position: "relative" as const,
  zIndex: focused ? 1 : 0,
});

// --- hide Steam's dialog chrome around the full-bleed panel ----------------
// Nodes we repaint belong to Steam and outlive the modal, so every touched
// property is remembered and restored once no marker of ours is connected.
type Touched = { markers: Set<HTMLElement>; saved: Map<string, [string, string]> };
const touched = new Map<HTMLElement, Touched>();
const VEIL = "rgba(0, 0, 0, 0.94)";

const setOwned = (el: HTMLElement, marker: HTMLElement, prop: string, value: string) => {
  let t = touched.get(el);
  if (!t) {
    t = { markers: new Set(), saved: new Map() };
    touched.set(el, t);
  }
  t.markers.add(marker);
  if (!t.saved.has(prop)) t.saved.set(prop, [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
  el.style.setProperty(prop, value, "important");
};

const releaseClosed = () => {
  touched.forEach((t, el) => {
    t.markers.forEach((m) => {
      if (!m.isConnected) t.markers.delete(m);
    });
    if (t.markers.size) return;
    t.saved.forEach(([v, prio], prop) => {
      if (v) el.style.setProperty(prop, v, prio);
      else el.style.removeProperty(prop);
    });
    touched.delete(el);
  });
};

// The element that really darkens the background is Steam's
// .ModalOverlayBackground, a sibling of the active overlay content.
const backdropOf = (marker: HTMLElement): HTMLElement | null => {
  let p: HTMLElement | null = marker.parentElement;
  for (let i = 0; p && i < 14; i++, p = p.parentElement) {
    if (p.classList.contains("ModalOverlayContent") && p.classList.contains("active")) {
      return p.parentElement?.querySelector<HTMLElement>(".ModalOverlayBackground") || null;
    }
  }
  return null;
};

const hideDialogChromeFrom = (marker: HTMLElement) => {
  if (!marker.isConnected) return;
  const backdrop = backdropOf(marker);
  if (backdrop) setOwned(backdrop, marker, "background", VEIL);
  // Measure through the node's own document: the plugin's global window is 1x1.
  const win = marker.ownerDocument?.defaultView;
  if (!win) return;
  let p: HTMLElement | null = marker.parentElement;
  for (let i = 0; p && i < 12; i++, p = p.parentElement) {
    const cs = win.getComputedStyle(p);
    const painted = cs.backgroundColor !== "rgba(0, 0, 0, 0)" || cs.backgroundImage !== "none" || cs.boxShadow !== "none";
    if (!painted) continue;
    if (p.getBoundingClientRect().width >= win.innerWidth * 0.98) {
      setOwned(p, marker, "background", VEIL);
      break;
    }
    setOwned(p, marker, "background", "transparent");
    setOwned(p, marker, "box-shadow", "none");
    setOwned(p, marker, "border", "none");
  }
};

// Several passes: the opening animation still moves measurements on mount.
export const chromeHideMarkerRef = (el: HTMLDivElement | null) => {
  if (!el) {
    [0, 400, 1200].forEach((ms) => setTimeout(releaseClosed, ms));
    return;
  }
  [0, 300, 800].forEach((ms) => setTimeout(() => hideDialogChromeFrom(el), ms));
};

// --- building blocks -------------------------------------------------------

const focusProps = (set: (v: boolean) => void) => ({
  onFocus: () => set(true),
  onBlur: () => set(false),
  onGamepadFocus: () => set(true),
  onGamepadBlur: () => set(false),
});

export const SidebarItem: FC<{ active: boolean; icon: ReactNode; label: string; badge?: ReactNode; onPick: () => void }> = ({
  active,
  icon,
  label,
  badge,
  onPick,
}) => {
  const [focused, setFocused] = useState(false);
  return (
    <Focusable
      noFocusRing
      onClick={onPick}
      onActivate={onPick}
      {...focusProps(setFocused)}
      className="fx-xv-item"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 12px",
        borderRadius: 8,
        marginBottom: 5,
        background: active ? "rgba(70,65,217,.85)" : focused ? "rgba(255,255,255,.13)" : "transparent",
        fontWeight: active ? 700 : 500,
        ...focusHalo(focused, 1.02),
      }}
    >
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {badge}
    </Focusable>
  );
};

export const Tile: FC<{ onClick: () => void; active?: boolean; danger?: boolean; disabled?: boolean; flex?: boolean }> = ({
  children,
  onClick,
  active,
  danger,
  disabled,
  flex,
}) => {
  const [focused, setFocused] = useState(false);
  const act = disabled ? () => {} : onClick;
  return (
    <Focusable
      noFocusRing
      onClick={act}
      onActivate={act}
      {...focusProps(setFocused)}
      style={{
        ...(flex ? { flex: 1, minWidth: 0 } : { flexShrink: 0 }),
        display: "flex",
        alignItems: "center",
        gap: 11,
        padding: "10px 12px",
        borderRadius: 9,
        opacity: disabled ? 0.5 : 1,
        background: danger
          ? focused ? "rgba(237,66,69,.5)" : "rgba(237,66,69,.28)"
          : active ? "rgba(35,165,90,.38)" : focused ? "rgba(70,65,217,.32)" : "rgba(255,255,255,.045)",
        ...listHalo(focused),
      }}
    >
      {children}
    </Focusable>
  );
};

// Keeps the focused element's scrollIntoView from scrolling ancestors.
export const pinTop = (e: any) => {
  if (e.currentTarget.scrollTop) e.currentTarget.scrollTop = 0;
};

export const SIDEBAR_FIT = `.fx-xv-side::-webkit-scrollbar { display: none; }
@media (max-height: 640px) {
  .fx-xv-side { padding-top: 8px !important; padding-bottom: 8px !important; }
  .fx-xv-brand { padding: 2px 8px 8px !important; }
  .fx-xv-item { padding-top: 7px !important; padding-bottom: 7px !important; margin-bottom: 3px !important; }
  .fx-xv-foot { padding-top: 6px !important; }
}`;

// --- shared people widgets -------------------------------------------------

const STATUS_COLOR: Record<string, string> = { online: ONLINE, idle: "#f0b232", dnd: DANGER };

export const statusText = (s: string) => (s === "dnd" ? "Do not disturb" : s.charAt(0).toUpperCase() + s.slice(1));

export const Avatar: FC<{ name: string; status?: string; size?: number }> = ({ name, status, size = 38 }) => (
  <span style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "linear-gradient(135deg,#4641d9,#8b5cf6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 700,
        fontSize: size * 0.4,
      }}
    >
      {(name || "?")[0]?.toUpperCase()}
    </span>
    {status && (
      <span
        style={{
          position: "absolute",
          right: -1,
          bottom: -1,
          width: 12,
          height: 12,
          borderRadius: "50%",
          border: "2px solid #11151d",
          background: STATUS_COLOR[status] || "#80848e",
        }}
      />
    )}
  </span>
);

// Small filter / action button used on the Friends bar and in rows.
export const Btn: FC<{ onClick: () => void; on?: boolean; grow?: boolean; disabled?: boolean }> = ({ onClick, children, on, grow, disabled }) => {
  const [focused, setFocused] = useState(false);
  const act = disabled ? () => {} : onClick;
  return (
    <Focusable
      noFocusRing
      onClick={act}
      onActivate={act}
      {...focusProps(setFocused)}
      style={{
        ...(grow ? { flex: 1, minWidth: 0 } : { flexShrink: 0 }),
        display: "flex",
        alignItems: "center",
        justifyContent: grow ? "flex-start" : "center",
        gap: 8,
        minHeight: 44,
        padding: "0 12px",
        borderRadius: 9,
        fontWeight: 600,
        opacity: disabled ? 0.5 : 1,
        background: on ? "rgba(70,65,217,.8)" : focused ? "rgba(70,65,217,.32)" : "rgba(255,255,255,.05)",
        ...listHalo(focused),
      }}
    >
      {children}
    </Focusable>
  );
};

// Icon-sized button for the call panel at the bottom of the sidebar.
export const IconBtn: FC<{ onClick: () => void; on?: boolean; danger?: boolean; disabled?: boolean }> = ({ onClick, children, on, danger, disabled }) => {
  const [focused, setFocused] = useState(false);
  const act = disabled ? () => {} : onClick;
  return (
    <Focusable
      noFocusRing
      onClick={act}
      onActivate={act}
      {...focusProps(setFocused)}
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: 36,
        borderRadius: 8,
        opacity: disabled ? 0.5 : 1,
        background: danger ? "rgba(237,66,69,.4)" : on ? "rgba(237,66,69,.28)" : focused ? "rgba(255,255,255,.18)" : "rgba(255,255,255,.07)",
        ...focusHalo(focused, 1.04),
      }}
    >
      {children}
    </Focusable>
  );
};
