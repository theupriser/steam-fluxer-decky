import { call } from "@decky/api";
import { Focusable, SliderField } from "@decky/ui";
import { FC, useCallback, useEffect, useRef, useState } from "react";
import { DANGER, focusHalo, focusProps, Tile } from "./ui";

interface Device {
  id: string;
  label: string;
}

interface AudioSettings {
  inputDeviceId: string;
  outputDeviceId: string;
  inputVolume: number;
  outputVolume: number;
  inputs: Device[];
  outputs: Device[];
}

type Reply = Partial<AudioSettings> & { ok: boolean; error?: string };

const SEND_DELAY_MS = 250;
// Fluxer's own settings window: 0 to 200 percent, marks every 50.
const VOLUME_NOTCHES = [0, 50, 100, 150, 200].map((v, i) => ({ notchIndex: i, label: `${v}%`, value: v }));

// Same look as Fluxer's Audio settings: a title per group with a divider, then
// rows with the label on the left and a rounded field on the right.
const GroupTitle: FC = ({ children }) => (
  <div
    style={{
      fontSize: 17,
      fontWeight: 700,
      margin: "26px 4px 12px",
      paddingTop: 16,
      borderTop: "1px solid rgba(255,255,255,.1)",
    }}
  >
    {children}
  </div>
);

const Chevron: FC<{ open: boolean }> = ({ open }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform .12s ease" }}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

/** A row: label on the left, the control (a field) on the right. */
const Row: FC<{ label: string }> = ({ label, children }) => (
  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 18, margin: "0 4px 12px" }}>
    <div style={{ fontSize: 15, fontWeight: 650, paddingTop: 12, flex: "1 1 0", minWidth: 0 }}>{label}</div>
    <div style={{ flex: "0 0 62%", minWidth: 0 }}>{children}</div>
  </div>
);

/** A drop-down field: shows the chosen device, opens its list under itself. */
const Select: FC<{ value: string; devices: Device[]; disabled: boolean; onPick: (id: string) => void }> = ({
  value,
  devices,
  disabled,
  onPick,
}) => {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const current = devices.find((d) => d.id === value);
  const toggle = () => !disabled && setOpen((o) => !o);
  return (
    <>
      <Focusable
        noFocusRing
        onClick={toggle}
        onActivate={toggle}
        {...focusProps(setFocused)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          padding: "11px 14px",
          borderRadius: 10,
          background: "rgba(255,255,255,.06)",
          border: `1px solid ${focused || open ? "rgba(255,255,255,.55)" : "rgba(255,255,255,.18)"}`,
          opacity: disabled ? 0.5 : 1,
          ...focusHalo(focused, 1.01),
        }}
      >
        <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {current ? current.label : "Unavailable"}
        </span>
        <Chevron open={open} />
      </Focusable>
      {open && (
        <Focusable
          flow-children="column"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            marginTop: 6,
            padding: 6,
            borderRadius: 10,
            background: "rgba(255,255,255,.04)",
            border: "1px solid rgba(255,255,255,.12)",
          }}
        >
          {devices.map((d) => (
            <Tile
              key={d.id}
              flex
              active={d.id === value}
              onClick={() => {
                setOpen(false);
                if (d.id !== value) onPick(d.id);
              }}
            >
              <span style={{ minWidth: 0, flex: 1, fontWeight: d.id === value ? 650 : 400 }}>{d.label}</span>
            </Tile>
          ))}
        </Focusable>
      )}
    </>
  );
};

const Volume: FC<{ label: string; value: number; onChange: (v: number) => void }> = ({ label, value, onChange }) => (
  <div style={{ margin: "0 4px 6px" }}>
    <SliderField
      label={label}
      value={value}
      min={0}
      max={200}
      step={5}
      notchCount={VOLUME_NOTCHES.length}
      notchLabels={VOLUME_NOTCHES}
      notchTicksVisible
      showValue
      valueSuffix="%"
      onChange={onChange}
    />
  </div>
);

/**
 * Fluxer's own sound settings (the ones in its desktop settings window):
 * which microphone and speakers it uses, and the input and output volume.
 * Only shown while Fluxer runs, because the values live inside it.
 */
export const SoundSettings: FC = () => {
  const [audio, setAudio] = useState<AudioSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Volumes the slider shows while a change is still on its way to Fluxer.
  const [volumes, setVolumes] = useState<{ inputVolume?: number; outputVolume?: number }>({});
  const pending = useRef<{ inputVolume?: number; outputVolume?: number }>({});
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const take = (r: Reply) => {
    if (!r.ok) {
      setNote(r.error || "Could not read the sound settings.");
      return;
    }
    setNote(null);
    setAudio(r as AudioSettings);
  };

  useEffect(() => {
    call<[], Reply>("get_audio_settings").then(take).catch((e) => setNote(String(e?.message || e)));
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const send = useCallback(async (patch: Partial<AudioSettings>) => {
    setBusy(true);
    try {
      take(await call<[Partial<AudioSettings>], Reply>("set_audio_settings", patch));
    } catch (e: any) {
      setNote(String(e?.message || e));
    }
    setBusy(false);
  }, []);

  const setVolume = (key: "inputVolume" | "outputVolume", v: number) => {
    setVolumes((cur) => ({ ...cur, [key]: v }));
    pending.current = { ...pending.current, [key]: v };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const patch = pending.current;
      pending.current = {};
      await send(patch);
      setVolumes({});
    }, SEND_DELAY_MS);
  };

  if (!audio) {
    return note ? <div style={{ color: DANGER, fontSize: 12, margin: "8px 4px" }}>{note}</div> : null;
  }

  return (
    <>
      <GroupTitle>Input and output</GroupTitle>
      <Row label="Input device">
        <Select value={audio.inputDeviceId} devices={audio.inputs} disabled={busy} onPick={(id) => send({ inputDeviceId: id })} />
      </Row>
      <Row label="Output device">
        <Select value={audio.outputDeviceId} devices={audio.outputs} disabled={busy} onPick={(id) => send({ outputDeviceId: id })} />
      </Row>
      <GroupTitle>Volume</GroupTitle>
      <Volume label="Input volume" value={volumes.inputVolume ?? audio.inputVolume} onChange={(v) => setVolume("inputVolume", v)} />
      <Volume label="Output volume" value={volumes.outputVolume ?? audio.outputVolume} onChange={(v) => setVolume("outputVolume", v)} />
      {note && <div style={{ color: DANGER, fontSize: 12, margin: "8px 4px" }}>{note}</div>}
    </>
  );
};
