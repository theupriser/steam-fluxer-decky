import { call } from "@decky/api";
import { Focusable, TextField } from "@decky/ui";
import { FC, useEffect, useRef, useState } from "react";
import { FaArrowLeft, FaDownload, FaPlay, FaPlus, FaServer, FaSignInAlt } from "react-icons/fa";
import { FluxerState, refreshState } from "./state";
import { DANGER, ONLINE, Tile } from "./ui";

interface InstallStatus {
  installed: boolean;
  stage: "idle" | "download" | "extract" | "done" | "error";
  pct: number;
  error: string | null;
}

interface LoginStep {
  step: string;
  instances?: { name: string; host: string }[];
  error?: string | null;
  text?: string;
}

const Box: FC = ({ children }) => (
  <Focusable flow-children="column" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 8px 4px 4px" }}>
    {children}
  </Focusable>
);

const Lead: FC = ({ children }) => <div style={{ opacity: 0.7, lineHeight: 1.5, margin: "0 4px 14px" }}>{children}</div>;

const Row: FC = ({ children }) => <div style={{ marginBottom: 6 }}>{children}</div>;

const InstallStep: FC = () => {
  const [st, setSt] = useState<InstallStatus | null>(null);
  const busy = st?.stage === "download" || st?.stage === "extract";
  const poll = () => call<[], InstallStatus>("install_status").then(setSt).catch(() => {});

  useEffect(() => {
    poll();
  }, []);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, [busy]);

  const install = async () => {
    setSt({ installed: false, stage: "download", pct: 0, error: null });
    await call("install_fluxer");
    await poll();
    await refreshState();
  };

  return (
    <Box>
      <Lead>Fluxer is not installed on this device. It is installed from Flathub as a normal app (for your user, no root needed), so Fluxer also works in Game Mode without Desktop Mode.</Lead>
      <Row>
        <Tile active={!busy} disabled={busy} onClick={install}>
          <FaDownload />
          <span style={{ fontWeight: 650 }}>
            {st?.stage === "download" ? `Installing... ${st.pct}%` : st?.stage === "extract" ? "Unpacking..." : "Install Fluxer"}
          </span>
        </Tile>
      </Row>
      {busy && (
        <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,.1)", margin: "6px 4px" }}>
          <div style={{ height: 6, borderRadius: 3, background: ONLINE, width: `${st?.stage === "extract" ? 100 : st?.pct || 0}%`, transition: "width .3s" }} />
        </div>
      )}
      {st?.stage === "error" && <div style={{ color: DANGER, margin: "8px 4px" }}>Install failed: {st.error}</div>}
    </Box>
  );
};

const StartStep: FC = () => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call<[], { ok: boolean; error?: string }>("start");
      if (!r.ok) setError(r.error || "Fluxer did not start.");
    } catch (e: any) {
      setError(String(e?.message || e));
    }
    await refreshState();
    setBusy(false);
  };
  return (
    <Box>
      <Lead>Fluxer runs hidden in the background; this view talks to it. Start it to continue.</Lead>
      <Row>
        <Tile active disabled={busy} onClick={start}>
          <FaPlay />
          <span style={{ fontWeight: 650 }}>{busy ? "Starting..." : "Start Fluxer"}</span>
        </Tile>
      </Row>
      {error && <div style={{ color: DANGER, margin: "8px 4px" }}>{error}</div>}
    </Box>
  );
};

const LoginSteps: FC = () => {
  const [st, setSt] = useState<LoginStep | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [host, setHost] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const busyRef = useRef(false);
  busyRef.current = busy;

  const poll = () => {
    if (busyRef.current) return;
    call<[], LoginStep>("login_state").then((r) => !busyRef.current && setSt(r)).catch(() => {});
  };
  useEffect(() => {
    poll();
    const id = setInterval(poll, 2500);
    return () => clearInterval(id);
  }, []);

  const act = async (method: string, ...args: any[]) => {
    setBusy(true);
    try {
      const r = await call<any[], LoginStep & { ok?: boolean }>(method, ...args);
      setSt(r);
      if (r.step === "logged_in") await refreshState();
    } catch (e: any) {
      setSt({ step: "unknown", error: String(e?.message || e) });
    }
    setPassword("");
    setBusy(false);
  };

  const step = st?.step;
  const back = (
    <Row>
      <Tile disabled={busy} onClick={() => act("login_back")}>
        <FaArrowLeft />
        <span style={{ fontWeight: 650 }}>Back</span>
      </Tile>
    </Row>
  );

  if (!step || step === "not_running" || step === "language" || step === "method") {
    return <Box><Lead>Getting Fluxer ready...</Lead></Box>;
  }
  if (step === "logged_in") {
    return <Box><Lead>Signed in. Loading your conversations...</Lead></Box>;
  }
  if (step === "instance") {
    return (
      <Box>
        <Lead>Choose the Fluxer instance your account is on.</Lead>
        {(st?.instances || []).map((i) => (
          <Row key={i.host}>
            <Tile flex disabled={busy} onClick={() => act("login_choose_instance", i.host, false)}>
              <FaServer style={{ opacity: 0.7 }} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontWeight: 650 }}>{i.name}</span>
                <span style={{ display: "block", marginTop: 2, fontSize: 11, opacity: 0.58 }}>{i.host}</span>
              </span>
            </Tile>
          </Row>
        ))}
        {adding ? (
          <Row>
            <TextField label="Instance address (e.g. example.com)" value={host} onChange={(e: any) => setHost(e?.target?.value ?? "")} />
            <Focusable flow-children="row" style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <Tile disabled={busy || !host.trim()} active onClick={() => act("login_choose_instance", host, true)}>
                <span style={{ fontWeight: 650 }}>{busy ? "..." : "Continue"}</span>
              </Tile>
              <Tile onClick={() => setAdding(false)}><span style={{ fontWeight: 650 }}>Cancel</span></Tile>
            </Focusable>
          </Row>
        ) : (
          <Row>
            <Tile flex onClick={() => setAdding(true)}>
              <FaPlus style={{ opacity: 0.7 }} />
              <span style={{ fontWeight: 650 }}>Add another instance</span>
            </Tile>
          </Row>
        )}
        {st?.error && <div style={{ color: DANGER, margin: "8px 4px" }}>{st.error}</div>}
      </Box>
    );
  }
  if (step === "credentials") {
    return (
      <Box>
        {back}
        <Lead>Sign in with your email and password. They go straight to Fluxer and are not stored by the plugin.</Lead>
        <Row><TextField label="Email" value={email} onChange={(e: any) => setEmail(e?.target?.value ?? "")} /></Row>
        <Row><TextField label="Password" bIsPassword value={password} onChange={(e: any) => setPassword(e?.target?.value ?? "")} /></Row>
        <Row>
          <Tile active disabled={busy || !email.trim() || !password} onClick={() => act("login_submit", email.trim(), password)}>
            <FaSignInAlt />
            <span style={{ fontWeight: 650 }}>{busy ? "Signing in..." : "Sign in"}</span>
          </Tile>
        </Row>
        {st?.error && <div style={{ color: DANGER, margin: "8px 4px" }}>{st.error}</div>}
      </Box>
    );
  }
  if (step === "mfa") {
    return (
      <Box>
        <Lead>Enter the verification code from your authenticator app.</Lead>
        <Row><TextField label="Code" value={code} onChange={(e: any) => setCode(e?.target?.value ?? "")} /></Row>
        <Row>
          <Tile active disabled={busy || !code.trim()} onClick={() => act("login_code", code.trim())}>
            <span style={{ fontWeight: 650 }}>{busy ? "Verifying..." : "Verify"}</span>
          </Tile>
        </Row>
        {st?.error && <div style={{ color: DANGER, margin: "8px 4px" }}>{st.error}</div>}
      </Box>
    );
  }
  return (
    <Box>
      {back}
      <Lead>Fluxer needs a step this view can't do (for example a captcha). Sign in once in Desktop Mode, then come back.</Lead>
      {st?.text && <div style={{ fontSize: 11, opacity: 0.5, margin: "0 4px" }}>{st.text}</div>}
    </Box>
  );
};

/** Install, start and sign in, in that order, until Fluxer is usable. */
export const SetupWizard: FC<{ state?: FluxerState }> = ({ state }) => {
  if (!state) return <Box><Lead>Loading...</Lead></Box>;
  if (!state.installed) return <InstallStep />;
  if (!state.running) return <StartStep />;
  return <LoginSteps />;
};
