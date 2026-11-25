import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { CommandSchema, FirmwareSampleSchema, InputsSchema, ScenarioSchema, GpioStateSchema, GpioInputsSchema, PeripheralsSchema, TOPOLOGY, type Command, type InputSnapshot, type SessionState } from '../../shared/protocol';

const sampleSchema = FirmwareSampleSchema.extend({ epoch: z.number().int().nonnegative(), wallMs: z.number(), virtualMs: z.number() });
const stateSchema = z.object({
  v: z.literal(1), epoch: z.number().int().nonnegative(), phase: z.enum(['starting', 'running', 'paused', 'stopped', 'error']),
  wallMs: z.number(), virtualMs: z.number(), inputs: InputsSchema, latest: sampleSchema.nullable(), history: z.array(sampleSchema),
  events: z.array(z.object({ seq: z.number(), epoch: z.number(), virtualMs: z.number(), wallMs: z.number(), source: z.enum(['i2c', 'gpio', 'control', 'firmware', 'system']), message: z.string() })),
  console: z.array(z.string()), scenarios: z.array(ScenarioSchema), error: z.string().nullable(),
  gpio: GpioStateSchema.nullable().optional(), gpioWallMs: z.number().optional(), gpioInputs: GpioInputsSchema.optional(),
  peripherals: PeripheralsSchema.optional(), gpioError: z.string().nullable().optional(),
  metrics: z.object({ samples: z.number(), droppedFrames: z.number(), qemuRssMb: z.number(), latencyP95Ms: z.number().nullable(), latencyCount: z.number() }),
});
const messageSchema = z.discriminatedUnion('type', [
  z.object({ v: z.literal(1), type: z.literal('state'), state: stateSchema }),
  z.object({ v: z.literal(1), type: z.literal('ack'), id: z.string(), epoch: z.number().int().nonnegative(), ok: z.boolean(), error: z.string().optional() }),
]);
const topologySchema = z.object({
  v: z.literal(1), target: z.string(), clockHz: z.number(),
  bus: z.object({ id: z.string(), sda: z.number(), scl: z.number(), routing: z.string() }),
  devices: z.array(z.object({ id: z.enum(['tmp105', 'bh1750', 'bme280']), name: z.string(), address: z.number().int(), channels: z.array(z.string()), conversionMs: z.number() })), limitations: z.array(z.string()),
});
export type Topology = z.infer<typeof topologySchema>;
type Payload = Command extends infer Candidate ? Candidate extends Command ? Omit<Candidate, 'v' | 'id' | 'epoch'> : never : never;
type Pending = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; epoch: number; action: Command['action'] };

export function useSession() {
  const [state, setState] = useState<SessionState | null>(null);
  const [topology, setTopology] = useState<Topology>({ ...TOPOLOGY, devices: TOPOLOGY.devices.map(device => ({ ...device, channels: [...device.channels] })), limitations: [...TOPOLOGY.limitations] });
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const [draftInputs, setDraftInputs] = useState<InputSnapshot | null>(null);
  const [inputPending, setInputPending] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [canCommand, setCanCommand] = useState(false);
  const [generation, setGeneration] = useState(0);
  const stateRef = useRef<SessionState | null>(null);
  const liveState = useRef(false);
  const lastLiveState = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  const pending = useRef(new Map<string, Pending>());
  const draftRef = useRef<InputSnapshot | null>(null);
  const desiredRevision = useRef(0);
  const inputTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputFlight = useRef(false);
  const confirmedTarget = useRef<InputSnapshot | null>(null);
  const active = useRef(true);

  function clearInputDraft() {
    if (inputTimer.current) clearTimeout(inputTimer.current);
    inputTimer.current = null;
    desiredRevision.current += 1;
    confirmedTarget.current = null;
    draftRef.current = null;
    setDraftInputs(null);
    setInputPending(false);
  }

  useEffect(() => {
    active.current = true;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const controller = new AbortController();
    function rejectPending(reason: string) {
      for (const entry of pending.current.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
      pending.current.clear();
      setPendingCount(0);
    }
    function receiveState(next: SessionState) {
      if (disposed) return;
      const previous = stateRef.current;
      if (previous && next.epoch < previous.epoch) return;
      if (previous && next.epoch === previous.epoch && next.wallMs < previous.wallMs) return;
      if (previous && next.epoch !== previous.epoch) {
        clearInputDraft();
        for (const [id, entry] of pending.current) {
          if (entry.epoch !== next.epoch && entry.action !== 'reset') {
            clearTimeout(entry.timer);
            pending.current.delete(id);
            entry.reject(new Error('Session epoch changed before command acknowledgement'));
          }
        }
        setPendingCount(pending.current.size);
      }
      stateRef.current = next;
      setState({ ...next, history: next.history.slice(-600), events: next.events.slice(-256), console: next.console.slice(-200) });
      setReceivedAt(Date.now());
      if (confirmedTarget.current && !inputTimer.current && !inputFlight.current) clearInputDraft();
    }
    async function fallback() {
      try {
        const response = await fetch('/api/state', { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`State endpoint: HTTP ${response.status}`);
        const body: unknown = await response.json();
        const direct = stateSchema.safeParse(body);
        const wrapped = messageSchema.safeParse(body);
        const snapshot = direct.success ? direct.data : wrapped.success && wrapped.data.type === 'state' ? wrapped.data.state : null;
        if (!snapshot) throw new Error('State endpoint returned an invalid snapshot');
        if (socketRef.current?.readyState !== WebSocket.OPEN) receiveState(snapshot);
      } catch (failure) { if (!disposed) setError(failure instanceof Error ? failure.message : 'State endpoint unavailable'); }
    }
    void fetch('/api/topology', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`Topology endpoint: HTTP ${response.status}`);
      const next = topologySchema.parse(await response.json());
      if (!disposed) setTopology(next);
    }).catch(failure => { if (!disposed) setError(failure instanceof Error ? failure.message : 'Topology unavailable'); });
    void fallback();
    function connect() {
      if (disposed) return;
      liveState.current = false;
      setCanCommand(false);
      setConnection('connecting');
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
      socketRef.current = socket;
      socket.onopen = () => { if (!disposed) { attempts = 0; setConnection('online'); setError(null); } };
      socket.onmessage = event => {
        if (disposed) return;
        try {
          const message = messageSchema.parse(JSON.parse(String(event.data)));
          if (message.type === 'state') {
            liveState.current = true;
            lastLiveState.current = Date.now();
            setCanCommand(true);
            receiveState(message.state);
          }
          else {
            const entry = pending.current.get(message.id);
            if (!entry) return;
            clearTimeout(entry.timer);
            pending.current.delete(message.id);
            setPendingCount(pending.current.size);
            if (message.epoch !== entry.epoch && !(entry.action === 'reset' && message.epoch > entry.epoch)) entry.reject(new Error('Acknowledgement has a different session epoch'));
            else if (message.ok) entry.resolve();
            else entry.reject(new Error(message.error || 'Command rejected'));
          }
        } catch (failure) { setError(failure instanceof Error ? `Invalid server message: ${failure.message}` : 'Invalid server message'); }
      };
      socket.onerror = () => { if (!disposed) setError('WebSocket connection failed'); };
      socket.onclose = () => {
        if (disposed) return;
        socketRef.current = null;
        liveState.current = false;
        setCanCommand(false);
        setConnection('offline');
        rejectPending('Connection lost before acknowledgement');
        clearInputDraft();
        void fallback();
        if (attempts < 8) { const delay = Math.min(500 * 2 ** attempts, 8000); attempts += 1; retryTimer = setTimeout(connect, delay); }
        else setError('Reconnect limit reached. Retry the connection.');
      };
    }
    connect();
    return () => {
      disposed = true;
      active.current = false;
      liveState.current = false;
      controller.abort();
      clearTimeout(retryTimer);
      if (inputTimer.current) clearTimeout(inputTimer.current);
      inputTimer.current = null;
      for (const entry of pending.current.values()) { clearTimeout(entry.timer); entry.reject(new Error('Connection closed')); }
      pending.current.clear();
      const socket = socketRef.current;
      if (socket) { socket.onopen = null; socket.onclose = null; socket.onmessage = null; socket.onerror = null; socket.close(); }
      socketRef.current = null;
    };
  }, [generation]);

  function send(payload: Payload, expectedEpoch?: number): Promise<void> {
    const socket = socketRef.current;
    const current = stateRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !current || !liveState.current) return Promise.reject(new Error('No live connection or confirmed session'));
    if (Date.now() - lastLiveState.current > 3000) return Promise.reject(new Error('Session state is stale; reconnect before issuing commands'));
    if (expectedEpoch !== undefined && current.epoch !== expectedEpoch) return Promise.reject(new Error('Session reset during import; remaining commands were not sent'));
    const command = CommandSchema.parse({ ...payload, v: 1, id: crypto.randomUUID(), epoch: current.epoch });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.current.delete(command.id); setPendingCount(pending.current.size); reject(new Error('Command acknowledgement timed out; check confirmed state before retrying')); }, 8000);
      pending.current.set(command.id, { resolve, reject, timer, epoch: command.epoch, action: command.action });
      setPendingCount(pending.current.size);
      try { socket.send(JSON.stringify(command)); }
      catch (failure) { clearTimeout(timer); pending.current.delete(command.id); setPendingCount(pending.current.size); reject(failure); }
    });
  }
  async function flushInputs() {
    inputTimer.current = null;
    if (inputFlight.current || !draftRef.current) return;
    const revision = desiredRevision.current;
    const snapshot = InputsSchema.parse(draftRef.current);
    inputFlight.current = true;
    try {
      await send({ action: 'inputs', inputs: snapshot });
      if (!active.current) return;
      if (revision === desiredRevision.current) {
        confirmedTarget.current = snapshot;
        if (JSON.stringify(stateRef.current?.inputs) === JSON.stringify(snapshot)) clearInputDraft();
      }
    } catch (failure) { if (active.current) { setError(failure instanceof Error ? failure.message : 'Input update failed'); clearInputDraft(); } }
    finally { inputFlight.current = false; if (active.current && draftRef.current && revision !== desiredRevision.current) inputTimer.current = setTimeout(flushInputs, 20); }
  }
  function editInputs(change: (snapshot: InputSnapshot) => InputSnapshot) {
    const current = draftRef.current ?? stateRef.current?.inputs;
    if (!current) return;
    const next = InputsSchema.parse(change(current));
    draftRef.current = next;
    setDraftInputs(next);
    setInputPending(true);
    confirmedTarget.current = null;
    desiredRevision.current += 1;
    if (inputTimer.current) clearTimeout(inputTimer.current);
    inputTimer.current = setTimeout(flushInputs, 20);
  }
  return { state, topology, connection, canCommand, error, receivedAt, draftInputs, inputPending, pendingCount, send, editInputs, reportError: setError,
    reconnect: () => { clearInputDraft(); setGeneration(value => value + 1); } };
}
