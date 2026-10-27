import { call } from "@decky/api";
import { useEffect, useState } from "react";

export interface FluxerAccount {
  accountKey: string;
  userId: string | null;
  displayName: string | null;
  instanceHost: string | null;
  lastActive: number;
  isValid: boolean;
}

export interface VoiceState {
  channelId: string | null;
  channelName: string | null;
  connected: boolean;
  connecting: boolean;
  selfMute: boolean;
  selfDeaf: boolean;
}

export interface FluxerGuild {
  id: string;
  name: string | null;
  voiceChannels: { id: string; name: string }[];
}

export interface FluxerState {
  running: boolean;
  ready: boolean;
  logged_in: boolean;
  accounts: FluxerAccount[];
  active_account?: string | null;
  voice?: VoiceState | null;
  guilds?: FluxerGuild[];
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
