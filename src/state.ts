import { call } from "@decky/api";
import { useEffect, useState } from "react";

export interface FluxerAccount {
  accountKey: string;
  userId: string | null;
  displayName: string | null;
  instanceHost: string | null;
  lastActive: number;
  isValid: boolean;
  avatar?: string | null;
}

export interface VoiceState {
  channelId: string | null;
  channelName: string | null;
  connected: boolean;
  connecting: boolean;
  selfMute: boolean;
  selfDeaf: boolean;
  streaming?: boolean;
}

export interface FluxerChannel {
  id: string;
  name: string;
  category: string | null;
}

export interface FluxerGuild {
  id: string;
  name: string | null;
  icon?: string | null;
  textChannels: FluxerChannel[];
  voiceChannels: FluxerChannel[];
}

export interface FluxerPerson {
  id: string;
  name: string;
  status: string;
  avatar?: string | null;
}

export interface FluxerDm {
  id: string;
  type: number;
  name: string;
  recipients: FluxerPerson[];
  lastMessageId: string | null;
}

export interface FluxerPrompt {
  id: string;
  title: string;
  text: string;
  buttons: { index: number; label: string }[];
}

export interface FluxerState {
  installed?: boolean;
  fluxer_version?: string | null;
  prompt?: FluxerPrompt | null;
  problems?: { part: string; error: string }[];
  running: boolean;
  ready: boolean;
  logged_in: boolean;
  accounts: FluxerAccount[];
  active_account?: string | null;
  voice?: VoiceState | null;
  guilds?: FluxerGuild[];
  dms?: FluxerDm[];
  friends?: FluxerPerson[];
  error: string | null;
}

const POLL_MS = 3000;
const listeners = new Set<(s: FluxerState) => void>();
let current: FluxerState | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

export const refreshState = async () => {
  try {
    current = await call<[], FluxerState>("get_state");
    listeners.forEach((l) => l(current as FluxerState));
  } catch (e) {
    console.error("[Fluxer] get_state failed", e);
  }
};

/** One shared poll, running only while something is subscribed. */
export function useFluxerState() {
  const [state, setState] = useState<FluxerState | undefined>(current);
  useEffect(() => {
    listeners.add(setState);
    if (listeners.size === 1) timer = setInterval(refreshState, POLL_MS);
    refreshState();
    return () => {
      listeners.delete(setState);
      if (!listeners.size && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  }, []);
  return state;
}

// --- Steam menu entry switch (a plugin setting shared with the menu patch) ---
const menuListeners = new Set<(v: boolean) => void>();
let menuEntry = true;
let menuLoaded = false;

export const setMenuEntryEnabled = (v: boolean) => {
  menuEntry = v;
  menuListeners.forEach((l) => l(v));
};

/** Whether the Fluxer entry shows in the Steam main menu. */
export function useMenuEntry() {
  const [value, setValue] = useState(menuEntry);
  useEffect(() => {
    menuListeners.add(setValue);
    if (!menuLoaded) {
      menuLoaded = true;
      call<[], { menu_entry?: boolean }>("get_settings")
        .then((s) => setMenuEntryEnabled(s.menu_entry !== false))
        .catch(() => { menuLoaded = false; });
    }
    return () => { menuListeners.delete(setValue); };
  }, []);
  return value;
}
