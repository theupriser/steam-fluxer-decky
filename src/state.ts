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
  /** Everyone connected to the call, you included. */
  participants?: FluxerParticipant[];
}

/** Someone connected to a voice channel, and what they are doing there. */
export interface FluxerParticipant {
  id: string;
  name: string;
  avatar?: string | null;
  mute: boolean;
  deaf: boolean;
  streaming: boolean;
  video: boolean;
}

export interface FluxerChannel {
  id: string;
  name: string;
  category: string | null;
  /** Voice channels only: who is connected right now. */
  participants?: FluxerParticipant[];
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

// --- who is talking in the call (fast poll, only while in a call) -----------
const SPEAK_POLL_MS = 300;
// Fluxer's audio-level flag flips quickly between words: keep the ring on a
// moment after the last sign of speech so it does not flicker.
const SPEAK_HOLD_MS = 450;

/** User ids talking right now. Polls only while `active` (in a call). */
export function useSpeaking(active: boolean): Set<string> {
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!active) {
      setSpeaking((prev) => (prev.size ? new Set() : prev));
      return;
    }
    const lastSeen = new Map<string, number>();
    let stopped = false;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await call<[], { ok: boolean; ids: string[] }>("get_speaking");
        const now = Date.now();
        (r.ids || []).forEach((id) => lastSeen.set(id, now));
      } catch {
        // Keep the last picture; the hold below lets it fade out by itself.
      }
      busy = false;
      if (stopped) return;
      const now = Date.now();
      const on: string[] = [];
      lastSeen.forEach((t, id) => {
        if (now - t <= SPEAK_HOLD_MS) on.push(id);
        else lastSeen.delete(id);
      });
      setSpeaking((prev) => (prev.size === on.length && on.every((id) => prev.has(id)) ? prev : new Set(on)));
    };
    const timer = setInterval(tick, SPEAK_POLL_MS);
    tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active]);
  return speaking;
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
