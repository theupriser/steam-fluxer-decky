import { call } from "@decky/api";
import { Focusable, NavEntryPositionPreferences, TextField } from "@decky/ui";
import { FC, useEffect, useState } from "react";
import { Avatar, Btn, listHalo } from "./ui";

export interface ChatMessage {
  id: string;
  author: string;
  authorId: string | null;
  mine: boolean;
  ts: string;
  content: string;
}

const when = (ts: string) => {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString()} ${time}`;
};

const Message: FC<{ m: ChatMessage }> = ({ m }) => {
  const [focused, setFocused] = useState(false);
  return (
    <Focusable
      noFocusRing
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onGamepadFocus={() => setFocused(true)}
      onGamepadBlur={() => setFocused(false)}
      style={{ display: "flex", gap: 10, padding: "7px 8px", marginBottom: 3, borderRadius: 8, background: focused ? "rgba(255,255,255,.07)" : "transparent", ...listHalo(focused) }}
    >
      <Avatar name={m.author} size={34} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div>
          <span style={{ fontWeight: 700, color: m.mine ? "#a5a2ff" : undefined }}>{m.author}</span>
          <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.5 }}>{when(m.ts)}</span>
        </div>
        <div style={{ marginTop: 2, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.35 }}>{m.content}</div>
      </div>
    </Focusable>
  );
};

/** One conversation: history on top (anchored to the newest), composer below. */
export const ChatView: FC<{ channelId: string }> = ({ channelId }) => {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    call<[string], ChatMessage[]>("get_messages", channelId)
      .then((r) => setMessages(Array.isArray(r) ? r : []))
      .catch((e) => setError(String(e?.message || e)));

  useEffect(() => {
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const r = await call<[string, string], { ok: boolean; error?: string }>("send_message", channelId, text);
      if (r.ok) setDraft("");
      else setError(r.error || "Could not send.");
    } catch (e: any) {
      setError(String(e?.message || e));
    }
    await load();
    setSending(false);
  };

  return (
    <Focusable flow-children="column" noFocusRing style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, width: "100%" }}>
      {/* column-reverse anchors the view to the newest message without timers;
          the single Focusable child keeps its real height (flexShrink: 0). */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 4px 0 3px", display: "flex", flexDirection: "column-reverse", overflowAnchor: "none" }}>
        <Focusable flow-children="column" navEntryPreferPosition={NavEntryPositionPreferences.LAST} style={{ flexShrink: 0 }}>
          {messages === null && <div style={{ padding: 8, opacity: 0.6 }}>Loading messages...</div>}
          {messages !== null && messages.length === 0 && <div style={{ padding: 8, opacity: 0.5 }}>No messages yet.</div>}
          {messages?.map((m) => <Message key={m.id} m={m} />)}
        </Focusable>
      </div>
      <div style={{ marginTop: 8 }}>
        <TextField
          value={draft}
          placeholder="Message"
          onChange={(e: any) => setDraft(e?.target?.value ?? "")}
          onKeyDown={(e: any) => {
            if (e?.key === "Enter" && !e?.shiftKey) {
              e.preventDefault?.();
              send();
            }
          }}
          style={{ fontSize: 13, width: "100%" }}
        />
        <Focusable flow-children="row" style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <Btn disabled={sending || !draft.trim()} onClick={send}>{sending ? "..." : "Send"}</Btn>
        </Focusable>
        {error && <div style={{ color: "#ff6b6b", fontSize: 11, marginTop: 4 }}>{error}</div>}
      </div>
    </Focusable>
  );
};
