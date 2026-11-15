import { FC } from "react";
import { FluxerParticipant } from "./state";
import { Avatar, ONLINE } from "./ui";

const BASE_RING = "#1b1d26";

// A green circle around the picture while that person talks, like in Fluxer.
// A crisp solid ring, no glow: 3px green stroke with a 2px gap to the picture.
// The gap and stroke are always there (only the colour changes), so nothing
// moves when someone starts or stops talking.
const speakingRing = (on: boolean, base: string, width = 3) => ({
  padding: 2,
  border: `${width}px solid ${on ? ONLINE : base}`,
  boxShadow: "none",
  transition: "border-color .08s ease",
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
    <span style={{ display: "flex", alignItems: "center", flexShrink: 0, marginRight: 10 }} title={people.map((p) => p.name).join(", ")}>
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
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "2px 0 10px" }} title={people.map((p) => p.name).join(", ")}>
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
