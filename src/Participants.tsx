import { FC } from "react";
import { FaDesktop, FaMicrophoneSlash, FaVolumeMute } from "react-icons/fa";
import { FluxerParticipant } from "./state";
import { Avatar, DANGER } from "./ui";

/** Overlapping profile pictures of the people in a voice channel, for a list row. */
export const AvatarStack: FC<{ people?: FluxerParticipant[]; max?: number; size?: number }> = ({ people, max = 5, size = 28 }) => {
  if (!people || people.length === 0) return null;
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  const ring = "2px solid #1b1d26";
  return (
    <span style={{ display: "flex", alignItems: "center", flexShrink: 0, marginRight: 10 }} title={people.map((p) => p.name).join(", ")}>
      {shown.map((p, i) => (
        <span key={p.id} style={{ marginLeft: i === 0 ? 0 : -9, borderRadius: "50%", border: ring, display: "flex", opacity: p.deaf ? 0.55 : 1 }}>
          <Avatar name={p.name} src={p.avatar} size={size} />
        </span>
      ))}
      {more > 0 && (
        <span
          style={{
            marginLeft: -9,
            minWidth: size,
            height: size,
            borderRadius: size / 2,
            border: ring,
            boxSizing: "border-box",
            background: "rgba(255,255,255,.16)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontWeight: 700,
            padding: "0 6px",
          }}
        >
          +{more}
        </span>
      )}
    </span>
  );
};

/** The people in the call you are in: picture, name, and who is muted or sharing. */
export const ParticipantList: FC<{ people?: FluxerParticipant[]; max?: number }> = ({ people, max = 6 }) => {
  if (!people || people.length === 0) return null;
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, margin: "0 0 9px" }}>
      {shown.map((p) => (
        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Avatar name={p.name} src={p.avatar} size={24} />
          <span style={{ minWidth: 0, flex: 1, fontSize: 12, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", opacity: p.deaf ? 0.55 : 1 }}>
            {p.name}
          </span>
          {p.streaming && <FaDesktop size={11} style={{ opacity: 0.8, flexShrink: 0 }} />}
          {p.deaf ? (
            <FaVolumeMute size={12} style={{ color: DANGER, flexShrink: 0 }} />
          ) : p.mute ? (
            <FaMicrophoneSlash size={12} style={{ color: DANGER, flexShrink: 0 }} />
          ) : null}
        </div>
      ))}
      {more > 0 && <div style={{ fontSize: 11, opacity: 0.55, paddingLeft: 32 }}>+{more} more</div>}
    </div>
  );
};
