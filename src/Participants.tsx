import { FC } from "react";
import { FluxerParticipant } from "./state";
import { Avatar, ONLINE } from "./ui";

const BASE_RING = "#1b1d26";

// A green circle around the picture while that person talks, like in Fluxer.
const GLOW = "rgba(35,165,90,.85)";
const speakingRing = (on: boolean, base: string, width = 3) => ({
  border: `${width}px solid ${on ? ONLINE : base}`,
  // A solid halo just outside the ring plus a wide soft glow: easy to see from the couch.
  boxShadow: on ? `0 0 0 2px rgba(35,165,90,.45), 0 0 14px 5px ${GLOW}` : "none",
  transition: "border-color .08s ease, box-shadow .08s ease",
});

/** Overlapping profile pictures of the people in a voice channel, for a list row. */
export const AvatarStack: FC<{ people?: FluxerParticipant[]; speaking?: Set<string>; max?: number; size?: number }> = ({
  people,
  speaking,
  max = 5,
  size = 28,
}) => {
  if (!people || people.length === 0) return null;
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  return (
    // Padding gives the glow room; the negative margin keeps the row height.
    <span
      style={{ display: "flex", alignItems: "center", flexShrink: 0, padding: "8px 10px 8px 8px", margin: "-8px 2px -8px -8px" }}
      title={people.map((p) => p.name).join(", ")}
    >
      {shown.map((p, i) => {
        const talking = !!speaking?.has(p.id);
        return (
          <span
            key={p.id}
            style={{
              marginLeft: i === 0 ? 0 : -9,
              borderRadius: "50%",
              display: "flex",
              opacity: p.deaf ? 0.55 : 1,
              position: "relative",
              zIndex: talking ? 2 : 1,
              ...speakingRing(talking, BASE_RING),
            }}
          >
            <Avatar name={p.name} src={p.avatar} size={size} />
          </span>
        );
      })}
      {more > 0 && (
        <span
          style={{
            marginLeft: -9,
            minWidth: size,
            height: size,
            borderRadius: size / 2,
            border: `2px solid ${BASE_RING}`,
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

/** The call you are in: just the profile pictures, a green circle around whoever talks. */
export const CallPeople: FC<{ people?: FluxerParticipant[]; speaking?: Set<string>; size?: number }> = ({ people, speaking, size = 30 }) => {
  if (!people || people.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: 8, margin: "-2px -8px 2px -8px" }} title={people.map((p) => p.name).join(", ")}>
      {people.map((p) => (
        <span
          key={p.id}
          style={{ borderRadius: "50%", display: "flex", opacity: p.deaf ? 0.55 : 1, ...speakingRing(!!speaking?.has(p.id), "transparent") }}
        >
          <Avatar name={p.name} src={p.avatar} size={size} />
        </span>
      ))}
    </div>
  );
};
