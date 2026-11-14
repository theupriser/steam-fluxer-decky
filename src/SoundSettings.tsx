import { call } from "@decky/api";
import { Focusable, SliderField } from "@decky/ui";
import { FC, useCallback, useEffect, useRef, useState } from "react";
import { DANGER, Tile } from "./ui";

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

const Sub: FC = ({ children }) => (
  <div style={{ fontSize: 12, opacity: 0.7, margin: "10px 4px 6px" }}>{children}</div>
);

const DeviceList: FC<{ devices: Device[]; value: string; disabled: boolean; onPick: (id: string) => void }> = ({
  devices,
  value,
  disabled,
  onPick,
}) => (
  <Focusable flow-children="column" style={{ display: "flex", flexDirection: "column", gap: 5 }}>
    {devices.map((d) => (
      <Tile key={d.id} flex active={d.id === value} disabled={disabled} onClick={() => onPick(d.id)}>
        <span style={{ minWidth: 0, flex: 1, fontWeight: d.id === value ? 650 : 400 }}>{d.label}</span>
      </Tile>
    ))}
  </Focusable>
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
      <Sub>Speakers (output)</Sub>
      <DeviceList devices={audio.outputs} value={audio.outputDeviceId} disabled={busy} onPick={(id) => send({ outputDeviceId: id })} />
      <SliderField
        label="Output volume"
        value={volumes.outputVolume ?? audio.outputVolume}
        min={0}
        max={200}
        step={5}
        showValue
        valueSuffix="%"
        onChange={(v: number) => setVolume("outputVolume", v)}
      />
      <Sub>Microphone (input)</Sub>
      <DeviceList devices={audio.inputs} value={audio.inputDeviceId} disabled={busy} onPick={(id) => send({ inputDeviceId: id })} />
      <SliderField
        label="Input volume"
        value={volumes.inputVolume ?? audio.inputVolume}
        min={0}
        max={200}
        step={5}
        showValue
        valueSuffix="%"
        onChange={(v: number) => setVolume("inputVolume", v)}
      />
      {note && <div style={{ color: DANGER, fontSize: 12, margin: "8px 4px" }}>{note}</div>}
    </>
  );
};
