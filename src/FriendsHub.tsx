import { call } from "@decky/api";
import { Focusable, TextField } from "@decky/ui";
import { FC, useEffect, useRef, useState } from "react";
import { FaComment, FaPhone, FaSyncAlt } from "react-icons/fa";
import { FluxerPerson } from "./state";
import { Avatar, Btn, statusText } from "./ui";

interface Friends {
  friends: FluxerPerson[];
  incoming: FluxerPerson[];
  outgoing: FluxerPerson[];
}
type Filter = "online" | "all" | "pending";
type Res = { ok: boolean; error?: string; id?: string };

const PersonRow: FC<{
  person: FluxerPerson;
  pending?: "incoming" | "outgoing";
  onChat: (channelId: string, name: string) => void;
  onCall: (channelId: string) => void;
  onDone: () => void;
}> = ({ person, pending, onChat, onCall, onDone }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<Res | void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r && !r.ok) setError(r.error || "Something went wrong.");
    } catch (e: any) {
      setError(String(e?.message || e));
    }
    setBusy(false);
  };
  const withDm = (then: (id: string) => void) =>
    run(async () => {
      const r = await call<[string], Res>("open_dm", person.id);
      if (r.ok && r.id) then(r.id);
      return r;
    });
  const answer = (method: "friend_accept" | "friend_remove") =>
    run(async () => {
      const r = await call<[string], Res>(method, person.id);
      if (r.ok) onDone();
      return r;
    });
  const line = pending === "incoming" ? "Incoming friend request" : pending === "outgoing" ? "Outgoing friend request" : statusText(person.status);
  return (
    <div style={{ marginBottom: 5 }}>
      <Focusable flow-children="row" style={{ display: "flex", gap: 6 }}>
        <Btn grow onClick={pending ? () => {} : () => withDm((id) => onChat(id, person.name))}>
          <Avatar name={person.name} status={pending ? undefined : person.status} />
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: "block", fontWeight: 650, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{person.name}</span>
            <span style={{ display: "block", marginTop: 2, fontSize: 11, fontWeight: 400, opacity: 0.62 }}>{line}</span>
          </span>
          {!pending && <FaComment style={{ opacity: 0.7 }} />}
        </Btn>
        {busy ? (
          <Btn onClick={() => {}}>...</Btn>
        ) : pending === "incoming" ? (
          <>
            <Btn onClick={() => answer("friend_accept")}>Accept</Btn>
            <Btn onClick={() => answer("friend_remove")}>Decline</Btn>
          </>
        ) : pending === "outgoing" ? (
          <Btn onClick={() => answer("friend_remove")}>Cancel</Btn>
        ) : (
          <Btn onClick={() => withDm(onCall)}>
            <FaPhone /> Call
          </Btn>
        )}
      </Focusable>
      {error && <div style={{ color: "#ff7474", fontSize: 12, margin: "3px 4px 0" }}>{error}</div>}
    </div>
  );
};

export const FriendsHub: FC<{ onChat: (channelId: string, name: string) => void; onCall: (channelId: string) => void }> = ({ onChat, onCall }) => {
  const [data, setData] = useState<Friends | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("online");
  const [newName, setNewName] = useState("");
  const [addMsg, setAddMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const alive = useRef(true);

  const refresh = () =>
    call<[], Friends>("get_friends")
      .then((r) => {
        if (alive.current && r) {
          setData(r);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive.current) setError(String(e?.message || e));
      });

  useEffect(() => {
    alive.current = true;
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, []);

  const sendRequest = async () => {
    const name = newName.trim();
    if (!name || adding) return;
    setAdding(true);
    setAddMsg(null);
    try {
      const r = await call<[string], Res>("friend_request", name);
      if (r.ok) {
        setAddMsg("Friend request sent.");
        setNewName("");
        refresh();
      } else setAddMsg(`Could not send the request${r.error ? ": " + r.error : "."}`);
    } catch (e: any) {
      setAddMsg(String(e?.message || e));
    }
    setAdding(false);
  };

  if (error && !data) return <div style={{ color: "#ff7474" }}>{error}</div>;
  if (!data) return <div style={{ opacity: 0.65 }}>Loading...</div>;

  const online = data.friends.filter((f) => f.status && f.status !== "offline");
  const pendingCount = data.incoming.length + data.outgoing.length;
  const shown = filter === "online" ? online : data.friends;
  const row = (p: FluxerPerson, pending?: "incoming" | "outgoing") => (
    <PersonRow key={p.id} person={p} pending={pending} onChat={onChat} onCall={onCall} onDone={refresh} />
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Focusable flow-children="row" style={{ flexShrink: 0, display: "flex", gap: 6, marginBottom: 8 }}>
        <Btn on={filter === "online"} onClick={() => setFilter("online")}>Online · {online.length}</Btn>
        <Btn on={filter === "all"} onClick={() => setFilter("all")}>All · {data.friends.length}</Btn>
        <Btn on={filter === "pending"} onClick={() => setFilter("pending")}>Pending{pendingCount ? ` · ${pendingCount}` : ""}</Btn>
        <Btn onClick={refresh}><FaSyncAlt /></Btn>
      </Focusable>
      <Focusable flow-children="column" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "3px 8px 3px 3px" }}>
        {filter === "pending" ? (
          <>
            <Focusable flow-children="row" style={{ display: "flex", gap: 6, alignItems: "flex-end", marginBottom: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <TextField label="Add a friend (name#0000)" value={newName} onChange={(e: any) => setNewName(String(e?.target?.value ?? "").slice(0, 64))} />
              </div>
              <Btn onClick={sendRequest}>{adding ? "..." : "Send"}</Btn>
            </Focusable>
            {addMsg && <div style={{ fontSize: 12, opacity: 0.85, margin: "0 4px 10px" }}>{addMsg}</div>}
            {data.incoming.map((p) => row(p, "incoming"))}
            {data.outgoing.map((p) => row(p, "outgoing"))}
            {pendingCount === 0 && <div style={{ opacity: 0.6, margin: "6px 4px" }}>No pending requests.</div>}
          </>
        ) : (
          <>
            {shown.map((p) => row(p))}
            {shown.length === 0 && <div style={{ opacity: 0.6, margin: "6px 4px" }}>{filter === "online" ? "Nobody is online." : "No friends yet."}</div>}
          </>
        )}
      </Focusable>
    </div>
  );
};
