import { StrictMode, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, CircleHelp, Cpu, FileInput, Lightbulb, LoaderCircle, Pause, Play, Radio, RotateCcw, Square, Terminal, Thermometer, Waves, X, Zap } from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { z } from 'zod';
import { CHANNELS, InputsSchema, ScenarioSchema, type Channel, type DeviceId, type InputSnapshot, type SamplePoint, type Scenario, type SessionState } from '../../shared/protocol';
import { createBoardBitmap } from './board';
import { useSession } from './useSession';
import { PeripheralsPanel } from './PeripheralsPanel';
import './styles.css';

const DEVICE_IDS: DeviceId[] = ['tmp105', 'bh1750', 'bme280'];
const channelInfo: Record<Channel, { name: string; unit: string; scale: number; digits: number }> = {
  temperatureC: { name: 'Temperature', unit: '\u00b0C', scale: 1, digits: 2 },
  lux: { name: 'Illuminance', unit: 'lx', scale: 1, digits: 1 },
  pressurePa: { name: 'Pressure', unit: 'hPa', scale: 100, digits: 2 },
  humidityPct: { name: 'Humidity', unit: '% RH', scale: 1, digits: 2 },
};
const bounds: Record<DeviceId, Partial<Record<Channel, [number, number, number]>>> = {
  tmp105: { temperatureC: [-55, 125, 0.1] }, bh1750: { lux: [0, 54000, 1] },
  bme280: { temperatureC: [-40, 85, 0.1], pressurePa: [300, 1100, 0.1], humidityPct: [0, 100, 0.1] },
};
const bundleSchema = z.object({ v: z.literal(1), inputs: InputsSchema, scenarios: z.array(ScenarioSchema).max(5) }).strict().superRefine((bundle, context) => {
  const targets = bundle.scenarios.map(scenario => `${scenario.deviceId}:${scenario.channel}`);
  if (new Set(targets).size !== targets.length) context.addIssue({ code: 'custom', message: 'Duplicate scenario target' });
});
const frameSchema = z.array(z.object({ timeMs: z.number().finite().nonnegative(), value: z.number().finite() }).strict()).max(10000);
const initialScenario: Scenario = { deviceId: 'tmp105', channel: 'temperatureC', kind: 'manual', offset: 0, amplitude: 0, periodMs: 10000, seed: 1, frames: [] };
function valueOf(inputs: InputSnapshot, device: DeviceId, channel: Channel): number { return (inputs[device] as unknown as Record<Channel, number>)[channel]; }
function observed(sample: SamplePoint | null, device: DeviceId, channel: Channel): number | null {
  const reading = sample?.[device];
  if (!reading || reading.error !== 0) return null;
  return (reading as unknown as Record<Channel, number | null>)[channel] ?? null;
}
function format(value: number | null | undefined, channel: Channel): string { return value == null ? '\u2014' : (value / channelInfo[channel].scale).toLocaleString(undefined, { minimumFractionDigits: channelInfo[channel].digits, maximumFractionDigits: channelInfo[channel].digits }); }
function time(value: number): string { return `${(value / 1000).toFixed(2)} s`; }
function failureText(failure: unknown): string { return failure instanceof z.ZodError ? failure.issues.map(issue => `${issue.path.join('.') || 'File'}: ${issue.message}`).join('; ') : failure instanceof Error ? failure.message : 'Operation failed'; }

function ToolButton({ label, children, onClick, disabled = false, danger = false }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return <span className="tool-wrap"><button type="button" className={`icon-button${danger ? ' danger' : ''}`} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button><span className="tooltip" role="tooltip">{label}</span></span>;
}
function NumericControl({ device, channel, value, confirmed, disabled, onChange }: { device: DeviceId; channel: Channel; value: number; confirmed: number; disabled: boolean; onChange: (value: number) => void }) {
  const info = channelInfo[channel];
  const [minimum, maximum, step] = bounds[device][channel]!;
  const [text, setText] = useState(String(Number((value / info.scale).toFixed(3))));
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(String(Number((value / info.scale).toFixed(3)))); }, [value, info.scale]);
  function commit() {
    const parsed = Number(text);
    if (text.trim() === '' || !Number.isFinite(parsed) || parsed < minimum || parsed > maximum) { setInvalid(true); return; }
    setInvalid(false);
    if (parsed * info.scale !== value) onChange(parsed * info.scale);
  }
  const id = `${device}-${channel}`;
  return <div className="numeric-control"><div className="field-heading"><label htmlFor={id}>{info.name}</label><span className="unit">{info.unit}</span></div><div className="field-track"><input aria-label={`${device.toUpperCase()} ${info.name} slider`} type="range" min={minimum} max={maximum} step={step} value={value / info.scale} disabled={disabled} onChange={event => { setInvalid(false); setText(event.target.value); onChange(Number(event.target.value) * info.scale); }} /><input id={id} type="number" min={minimum} max={maximum} step={step} value={text} disabled={disabled} aria-invalid={invalid} onFocus={() => { focused.current = true; }} onChange={event => { setText(event.target.value); setInvalid(false); }} onBlur={() => { focused.current = false; commit(); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></div><div className="field-foot"><span>{minimum} to {maximum}</span><span>Confirmed <b>{format(confirmed, channel)}</b></span></div>{invalid && <span className="field-error" role="alert">Enter {minimum} to {maximum} {info.unit}</span>}</div>;
}
function DeviceInputs({ device, state, draft, disabled, onEdit }: { device: DeviceId; state: SessionState; draft: InputSnapshot; disabled: boolean; onEdit: (change: (snapshot: InputSnapshot) => InputSnapshot) => void }) {
  const icon = device === 'tmp105' ? <Thermometer size={17} /> : device === 'bh1750' ? <Lightbulb size={17} /> : <Waves size={17} />;
  const address = device === 'tmp105' ? '0x48' : device === 'bh1750' ? '0x23' : '0x76';
  function field(channel: Channel, value: number) { onEdit(snapshot => ({ ...snapshot, [device]: { ...snapshot[device], [channel]: value } })); }
  function fault(key: 'connected' | 'invalid', value: boolean) { onEdit(snapshot => ({ ...snapshot, [device]: { ...snapshot[device], [key]: value } })); }
  return <section className="device-input" aria-label={`${device.toUpperCase()} physical inputs`}><div className="device-heading"><h3>{icon}{device.toUpperCase()}</h3><span className="address">{address}</span></div>{CHANNELS[device].map(channel => <NumericControl key={channel} device={device} channel={channel} value={valueOf(draft, device, channel)} confirmed={valueOf(state.inputs, device, channel)} disabled={disabled} onChange={value => field(channel, value)} />)}<div className="fault-row"><label className="switch-label"><input type="checkbox" checked={draft[device].connected} disabled={disabled} onChange={event => fault('connected', event.target.checked)} /><span className="switch" />Connected</label><label className="switch-label fault"><input type="checkbox" checked={draft[device].invalid} disabled={disabled} onChange={event => fault('invalid', event.target.checked)} /><span className="switch" />Invalid data</label></div><div className="confirmed-fault">Confirmed: {state.inputs[device].connected ? 'connected' : 'disconnected'}{state.inputs[device].invalid ? ' / invalid' : ' / valid'}</div></section>;
}
function Observations({ state, stale }: { state: SessionState | null; stale: boolean }) {
  return <div className={`observations${stale ? ' stale' : ''}`}>{DEVICE_IDS.map(device => { const sample = state?.latest?.[device]; const error = sample?.error; return <section className="observation" key={device} aria-label={`${device.toUpperCase()} firmware observations`}><div className="observation-heading"><h3>{device.toUpperCase()}</h3><span className={`reading-status${error ? ' bad' : ''}`}>{sample ? error ? `ERR ${error}` : stale ? 'STALE' : 'OK' : 'NO SAMPLE'}</span></div>{CHANNELS[device].map(channel => <div className="reading" key={channel}><span>{channelInfo[channel].name}</span><div><strong>{format(observed(state?.latest ?? null, device, channel), channel)}</strong><span className="unit">{channelInfo[channel].unit}</span></div></div>)}</section>; })}</div>;
}
function SignalChart({ state, stale }: { state: SessionState | null; stale: boolean }) {
  const [channel, setChannel] = useState<Channel>('temperatureC');
  const [showTmp, setShowTmp] = useState(true);
  const [showBme, setShowBme] = useState(true);
  const info = channelInfo[channel];
  const data = (state?.history ?? []).filter(sample => sample.epoch === state?.epoch).map(sample => ({ virtualSeconds: sample.virtualMs / 1000, ...Object.fromEntries(DEVICE_IDS.map(device => { const value = observed(sample, device, channel); return [device, value == null ? null : value / info.scale]; })) }));
  const devices = DEVICE_IDS.filter(device => CHANNELS[device].includes(channel));
  return <section className="signals" aria-label="Live firmware chart"><div className="section-heading"><h2><Activity size={17} />Signal History</h2><span className="meta">{stale ? 'Stale' : 'Virtual clock'} / {data.length} samples</span></div><div className="channel-tabs" role="tablist" aria-label="Chart channel">{(Object.keys(channelInfo) as Channel[]).map(option => <button type="button" key={option} role="tab" aria-selected={option === channel} onClick={() => setChannel(option)}>{channelInfo[option].name}</button>)}</div><div className="chart-subhead"><span>{info.unit}</span>{channel === 'temperatureC' && <div className="series-select"><label><input type="checkbox" checked={showTmp} onChange={event => setShowTmp(event.target.checked)} />TMP105</label><label><input type="checkbox" checked={showBme} onChange={event => setShowBme(event.target.checked)} />BME280</label></div>}<span>Virtual time (s)</span></div><div className="chart-frame">{data.length ? <ResponsiveContainer width="100%" height="100%"><LineChart data={data} margin={{ top: 10, right: 14, bottom: 8, left: 0 }}><CartesianGrid stroke="#e7ece9" strokeDasharray="3 3" /><XAxis dataKey="virtualSeconds" type="number" domain={['dataMin', 'dataMax']} tickFormatter={value => Number(value).toFixed(1)} tick={{ fontSize: 11, fill: '#6a7671' }} minTickGap={28} /><YAxis width={62} domain={['auto', 'auto']} tick={{ fontSize: 11, fill: '#6a7671' }} tickFormatter={value => Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })} /><Tooltip labelFormatter={value => `${Number(value).toFixed(2)} s`} formatter={value => [`${Number(value).toLocaleString(undefined, { maximumFractionDigits: info.digits })} ${info.unit}`]} contentStyle={{ border: '1px solid #d6dfdb', borderRadius: 4, fontSize: 12 }} /><Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} />{devices.filter(device => channel !== 'temperatureC' || (device === 'tmp105' ? showTmp : showBme)).map(device => <Line key={device} name={device.toUpperCase()} dataKey={device} type="linear" stroke={device === 'tmp105' || device === 'bh1750' ? '#087f70' : '#b55e42'} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />)}</LineChart></ResponsiveContainer> : <div className="empty-chart"><Radio size={28} /><span>Waiting for firmware samples</span><small>{state ? `Session ${state.phase}` : 'No session received'}</small></div>}</div></section>;
}
function ConsolePanel({ lines, expanded = false }: { lines: string[]; expanded?: boolean }) {
  const [follow, setFollow] = useState(true);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => { if (follow && container.current) container.current.scrollTop = container.current.scrollHeight; }, [lines, follow]);
  return <section className={`console-panel${expanded ? ' expanded' : ''}`} aria-label="UART console"><div className="section-heading"><h2><Terminal size={17} />UART Console</h2><label className="compact-check"><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)} />Follow</label></div><div className="console-body" ref={container} tabIndex={0} aria-label="UART output">{lines.length ? lines.map((line, index) => <div className="console-line" key={`${index}-${line}`}><span className="line-number">{index + 1}</span><span>{line}</span></div>) : <div className="console-empty">No UART output received.</div>}</div><div className="panel-foot"><span>UART0</span><span>{lines.length} / 200 lines</span></div></section>;
}
function EventsPanel({ state, expanded = false }: { state: SessionState | null; expanded?: boolean }) {
  const [filter, setFilter] = useState('all');
  const events = (state?.events ?? []).filter(event => filter === 'all' || event.source === filter).slice().reverse();
  return <section className={`events-panel${expanded ? ' expanded' : ''}`} aria-label="I2C and control event timeline"><div className="section-heading"><h2><Zap size={17} />Event Timeline</h2><select aria-label="Event source" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All sources</option><option value="i2c">I2C</option><option value="control">Control</option><option value="firmware">Firmware</option><option value="system">System</option></select></div><div className="event-body" tabIndex={0}>{events.length ? events.map(event => <div className="event" key={`${event.epoch}-${event.seq}`}><span className="event-time">{time(event.virtualMs)}</span><span className={`source source-${event.source}`}>{event.source}</span><span className="event-message">{event.message}</span></div>) : <div className="empty-events">No {filter === 'all' ? '' : `${filter} `}events received.</div>}</div><div className="panel-foot"><span>Epoch {state?.epoch ?? '\u2014'}</span><span>{events.length} events</span></div></section>;
}
function parseFrames(text: string): Scenario['frames'] {
  const source = text.trim();
  if (!source) return [];
  if (source.startsWith('[')) return frameSchema.parse(JSON.parse(source));
  const rows = source.split(/\r?\n/).filter(row => row.trim() !== '');
  if (/^timeMs\s*,\s*value$/i.test(rows[0].trim())) rows.shift();
  return frameSchema.parse(rows.map((row, index) => { const cells = row.split(',').map(cell => cell.trim()); if (cells.length !== 2 || cells.some(cell => cell === '' || !Number.isFinite(Number(cell)))) throw new Error(`CSV row ${index + 1}: expected timeMs,value`); return { timeMs: Number(cells[0]), value: Number(cells[1]) }; }));
}
function ScenarioEditor({ state, disabled, apply }: { state: SessionState | null; disabled: boolean; apply: (scenario: Scenario) => Promise<void> }) {
  const [scenario, setScenario] = useState<Scenario>(initialScenario);
  const [frames, setFrames] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const playbackFile = useRef<HTMLInputElement>(null);
  const initialized = useRef(false);
  useEffect(() => { if (state && !initialized.current) { initialized.current = true; const existing = state.scenarios.find(entry => entry.deviceId === 'tmp105' && entry.channel === 'temperatureC'); setScenario(existing ?? { ...initialScenario, offset: state.inputs.tmp105.temperatureC }); if (existing?.frames.length) setFrames(JSON.stringify(existing.frames, null, 2)); } }, [state]);
  function selectTarget(target: string) {
    const [deviceId, channel] = target.split(':') as [DeviceId, Channel];
    const existing = state?.scenarios.find(entry => entry.deviceId === deviceId && entry.channel === channel);
    const next = existing ?? { ...initialScenario, deviceId, channel, offset: state ? valueOf(state.inputs, deviceId, channel) : 0 };
    setScenario(next); setFrames(next.frames.length ? JSON.stringify(next.frames, null, 2) : ''); setError(null); setSuccess(false);
  }
  async function submit() {
    setError(null); setSuccess(false); setBusy(true);
    try { const validated = ScenarioSchema.parse({ ...scenario, frames: scenario.kind === 'playback' ? parseFrames(frames) : [] }); await apply(validated); setSuccess(true); }
    catch (failure) { setError(failureText(failure)); }
    finally { setBusy(false); }
  }
  const existing = state?.scenarios.find(entry => entry.deviceId === scenario.deviceId && entry.channel === scenario.channel);
  return <section className="scenario-editor" aria-label="Scenario configuration"><div className="section-heading"><h2><Waves size={17} />Scenario</h2><span className="meta">{existing?.kind ?? 'manual'} confirmed</span></div><label className="stack-label">Target<select value={`${scenario.deviceId}:${scenario.channel}`} disabled={busy} onChange={event => selectTarget(event.target.value)}>{DEVICE_IDS.flatMap(device => CHANNELS[device].map(channel => <option key={`${device}:${channel}`} value={`${device}:${channel}`}>{device.toUpperCase()} / {channelInfo[channel].name}</option>))}</select></label><div className="scenario-modes" role="group" aria-label="Scenario mode">{(['manual', 'ramp', 'sine', 'noise', 'playback'] as const).map(kind => <button type="button" key={kind} aria-pressed={scenario.kind === kind} disabled={busy} onClick={() => { setScenario(current => ({ ...current, kind })); setSuccess(false); }}>{kind}</button>)}</div><div className="scenario-fields">{(['offset', 'amplitude', 'periodMs', 'seed'] as const).map(field => <label className="stack-label" key={field}>{field === 'periodMs' ? 'Period (ms)' : field === 'seed' ? 'Seed' : `${field === 'offset' ? 'Offset' : 'Amplitude'} (${scenario.channel === 'pressurePa' ? 'Pa' : channelInfo[scenario.channel].unit})`}<input type="number" value={Number.isNaN(scenario[field]) ? '' : scenario[field]} min={field === 'periodMs' ? 100 : field === 'amplitude' || field === 'seed' ? 0 : undefined} max={field === 'periodMs' ? 3600000 : field === 'seed' ? 4294967295 : undefined} step={field === 'seed' || field === 'periodMs' ? 1 : 'any'} disabled={busy} onChange={event => { setScenario(current => ({ ...current, [field]: event.target.value === '' ? NaN : Number(event.target.value) })); setSuccess(false); }} /></label>)}</div>{scenario.kind === 'playback' && <div className="playback"><div className="field-heading"><label htmlFor="playback-frames">Frames (ms, native units)</label><ToolButton label="Load playback CSV or JSON" onClick={() => playbackFile.current?.click()} disabled={busy}><FileInput size={16} /></ToolButton></div><textarea id="playback-frames" value={frames} rows={5} spellCheck={false} placeholder={'timeMs,value\n0,23\n1000,28'} disabled={busy} onChange={event => { setFrames(event.target.value); setSuccess(false); }} /><input className="hidden-file" ref={playbackFile} type="file" accept=".csv,.json,text/csv,application/json" onChange={async event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; try { if (file.size > 2_000_000) throw new Error('Playback file exceeds 2 MB'); const text = await file.text(); parseFrames(text); setFrames(text); setError(null); setSuccess(false); } catch (failure) { setError(failureText(failure)); } }} /></div>}{error && <div className="inline-error" role="alert">{error}</div>}<button className="primary-button apply-button" type="button" disabled={disabled || busy} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={16} /> : success ? <Check size={16} /> : <Play size={16} />}{busy ? 'Applying' : success ? 'Acknowledged' : 'Apply scenario'}</button></section>;
}
function App() {
  const session = useSession();
  const { state, topology, connection } = session;
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState<'signals' | 'uart' | 'events'>('signals');
  const [mobilePane, setMobilePane] = useState<'observe' | 'inputs'>('observe');
  const [controlBusy, setControlBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [boardImage, setBoardImage] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { setBoardImage(createBoardBitmap(topology)); }, [topology]);
  const age = session.receivedAt == null ? null : Math.max(0, now - session.receivedAt);
  const sampleAge = state?.latest ? Math.max(0, now - state.latest.wallMs) : null;
  const stale = connection !== 'online' || age == null || age > 2500 || sampleAge == null || sampleAge > 3000 || state?.phase !== 'running';
  const disabled = connection !== 'online' || !session.canCommand || !state || age == null || age > 3000 || controlBusy || fileBusy;
  const problem = session.error || state?.error;
  const draft = session.draftInputs ?? state?.inputs;
  async function control(action: 'run' | 'pause' | 'reset' | 'stop') {
    setControlBusy(true); setNotice(null);
    try { await session.send({ action }); } catch (failure) { session.reportError(failureText(failure)); } finally { setControlBusy(false); }
  }
  function exportScenario() {
    if (!state) return;
    try {
      const bundle = bundleSchema.parse({ v: 1, inputs: state.inputs, scenarios: state.scenarios });
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `espemu-scenario-epoch-${state.epoch}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { session.reportError(failureText(failure)); }
  }
  async function importScenario(file: File) {
    setFileBusy(true); setNotice(null); let applied = 0;
    try {
      if (file.size > 4_000_000) throw new Error('Scenario file exceeds 4 MB');
      const bundle = bundleSchema.parse(JSON.parse(await file.text()));
      if (!state) throw new Error('No confirmed session');
      const epoch = state.epoch;
      for (const existing of state.scenarios) if (!bundle.scenarios.some(entry => entry.deviceId === existing.deviceId && entry.channel === existing.channel)) { await session.send({ action: 'scenario', scenario: { ...existing, kind: 'manual', offset: valueOf(bundle.inputs, existing.deviceId, existing.channel), amplitude: 0, frames: [] } }, epoch); applied += 1; }
      await session.send({ action: 'inputs', inputs: bundle.inputs }, epoch); applied += 1;
      for (const scenario of bundle.scenarios) { await session.send({ action: 'scenario', scenario }, epoch); applied += 1; }
      setNotice('Scenario file acknowledged');
    } catch (failure) { session.reportError(`${failureText(failure)}${applied ? ` (${applied} earlier commands acknowledged; import is not atomic)` : ''}`); }
    finally { setFileBusy(false); }
  }
  return <div className="app-shell"><header className="app-header"><div className="brand"><div className="brand-mark"><Cpu size={23} /></div><div><h1>ESPEmu</h1><span>Live Workbench</span></div></div><div className="header-session"><span className={`connection-dot ${connection}`} /><span>{connection === 'online' ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Disconnected'}</span><span className="header-separator" /><span className={`phase phase-${state?.phase ?? 'stopped'}`}>{state?.phase ?? 'No session'}</span></div><div className="transport" role="group" aria-label="Session controls"><ToolButton label="Run" disabled={disabled || session.inputPending || state?.phase === 'running'} onClick={() => void control('run')}><Play size={18} /></ToolButton><ToolButton label="Pause" disabled={disabled || state?.phase !== 'running'} onClick={() => void control('pause')}><Pause size={18} /></ToolButton><ToolButton label="Reset" disabled={disabled || session.inputPending} onClick={() => void control('reset')}><RotateCcw size={18} /></ToolButton><ToolButton label="Stop" disabled={disabled || state?.phase === 'stopped'} danger onClick={() => void control('stop')}><Square size={17} /></ToolButton><span className="transport-separator" /><ToolButton label="Export scenario JSON" disabled={!state || session.inputPending || fileBusy} onClick={exportScenario}><ArrowDownToLine size={18} /></ToolButton><ToolButton label="Import scenario JSON" disabled={disabled || session.inputPending} onClick={() => fileInput.current?.click()}><ArrowUpFromLine size={18} /></ToolButton>{connection !== 'online' && <ToolButton label="Reconnect" onClick={session.reconnect}><Radio size={18} /></ToolButton>}</div><input ref={fileInput} className="hidden-file" type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importScenario(file); }} /></header>{problem && <div className="error-banner" role="alert"><span>{problem}</span>{session.error && <ToolButton label="Dismiss command error" onClick={() => session.reportError(null)}><X size={16} /></ToolButton>}</div>}{notice && <div className="notice-banner" role="status"><Check size={16} />{notice}<ToolButton label="Dismiss notice" onClick={() => setNotice(null)}><X size={16} /></ToolButton></div>}<main>
    <section className="topology-band" aria-label="ESP32 logical I2C topology"><div className="topology-main"><div className="section-heading"><h2><Cpu size={17} />{topology.target.toUpperCase()} / I2C0</h2><span className="meta">{(topology.clockHz / 1000).toFixed(0)} kHz</span></div>{boardImage && <img className="board-image" src={boardImage} width={1000} height={280} alt={`Logical ESP32 I2C bus, SDA GPIO ${topology.bus.sda}, SCL GPIO ${topology.bus.scl}, TMP105 at 0x48, BH1750 at 0x23, BME280 at 0x76`} title="Original ESPEmu logical topology bitmap. Not an electrical wiring diagram." />}<div className="topology-foot"><span className="mono">SDA GPIO{topology.bus.sda} / SCL GPIO{topology.bus.scl}</span><span className="fidelity" title={topology.limitations.join('\n')}><CircleHelp size={13} />Logical bus</span></div></div><div className="session-metrics"><div className="section-heading"><h2>Session</h2><span className="meta">Epoch {state?.epoch ?? '\u2014'}</span></div><dl><div><dt>Virtual time</dt><dd>{state ? time(state.virtualMs) : '\u2014'}</dd></div><div><dt>Samples</dt><dd>{state?.metrics.samples.toLocaleString() ?? '\u2014'}</dd></div><div><dt>Latency p95</dt><dd>{state?.metrics.latencyP95Ms == null ? '\u2014' : `${state.metrics.latencyP95Ms.toFixed(1)} ms`}</dd></div><div><dt>QEMU RSS</dt><dd>{state ? `${state.metrics.qemuRssMb.toFixed(1)} MB` : '\u2014'}</dd></div><div><dt>Dropped frames</dt><dd className={state?.metrics.droppedFrames ? 'bad-text' : ''}>{state?.metrics.droppedFrames ?? '\u2014'}</dd></div></dl><div className={`freshness${stale ? ' is-stale' : ''}`}><span className={`connection-dot ${stale ? 'offline' : 'online'}`} /><span>{session.receivedAt == null ? 'Awaiting state' : `${stale ? 'Readings stale' : 'Live readings'} / state ${age! < 1000 ? '<1' : Math.floor(age! / 1000)} s ago`}</span></div></div></section>
    <div className="mobile-pane-tabs" role="tablist" aria-label="Workbench pane"><button type="button" role="tab" aria-selected={mobilePane === 'observe'} onClick={() => setMobilePane('observe')}><Activity size={16} />Observations</button><button type="button" role="tab" aria-selected={mobilePane === 'inputs'} onClick={() => setMobilePane('inputs')}><ChevronDown size={16} />Physical Inputs</button></div><div className={`workspace pane-${mobilePane}`}><aside className="input-sidebar"><div className="section-heading sidebar-heading"><h2>Physical Inputs</h2><span className={`pending-label${session.inputPending ? ' pending' : ''}`}>{session.inputPending ? 'Pending' : state ? 'Confirmed' : 'Unavailable'}</span></div>{state && draft ? DEVICE_IDS.map(device => <DeviceInputs key={device} device={device} state={state} draft={draft} disabled={disabled} onEdit={session.editInputs} />) : <div className="inputs-empty"><LoaderCircle size={20} className={connection === 'connecting' ? 'spin' : ''} /><span>Awaiting confirmed inputs</span></div>}<ScenarioEditor state={state} disabled={disabled || session.inputPending} apply={scenario => session.send({ action: 'scenario', scenario })} /></aside><div className="observation-workspace"><div className="observation-title"><h2>Firmware Observations</h2><span className="meta">{state?.latest ? `SEQ ${state.latest.seq} / ${time(state.latest.virtualMs)}` : 'No telemetry'}</span></div><Observations state={state} stale={stale} /><nav className="view-tabs" aria-label="Observation views">{([{ id: 'signals', name: 'Signals', icon: <Activity size={16} /> }, { id: 'uart', name: 'UART', icon: <Terminal size={16} /> }, { id: 'events', name: 'Events', icon: <Zap size={16} /> }] as const).map(tab => <button type="button" key={tab.id} aria-pressed={view === tab.id} onClick={() => setView(tab.id)}>{tab.icon}{tab.name}{tab.id === 'events' && <span className="tab-count">{state?.events.length ?? 0}</span>}</button>)}</nav>{view === 'signals' ? <><SignalChart state={state} stale={stale} /><div className="log-grid"><ConsolePanel lines={state?.console ?? []} /><EventsPanel state={state} /></div></> : view === 'uart' ? <ConsolePanel lines={state?.console ?? []} expanded /> : <EventsPanel state={state} expanded />}</div></div>
    <PeripheralsPanel state={state} disabled={disabled} send={session.send} />
    </main><footer><span><span className={`connection-dot ${connection}`} />{connection === 'online' ? '/ws' : 'Offline'}<span className="footer-divider">/</span>{session.pendingCount ? `${session.pendingCount} awaiting ACK` : 'No pending commands'}</span><span>ESP32 / logical I2C / UART0</span></footer></div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
