import { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { pcmSamples, type AudioMessage, type SpeakerState } from '../../shared/speaker';
import type { CircuitDevice } from '../../shared/registry';

const LEAD_SECONDS = 0.12, MAX_QUEUE_SECONDS = 0.6;

/** Pitch from rising zero crossings; adequate for tones, not a spectrum analyzer. */
function pitch(samples: Int16Array, rate: number): number | null {
  let crossings = 0, first = -1, last = -1;
  for (let index = 1; index < samples.length; index++) if (samples[index - 1] < 0 && samples[index] >= 0) { crossings++; if (first < 0) first = index; last = index; }
  return crossings > 2 ? (crossings - 1) * rate / (last - first) : null;
}

export function SpeakerPanel({ device, speaker, subscribe }: {
  device: Extract<CircuitDevice, { type: 'max98357a' }>; speaker: SpeakerState | null | undefined;
  subscribe: (listener: (message: AudioMessage) => void) => () => void;
}) {
  const [enabled, setEnabled] = useState(false), [volume, setVolume] = useState(0.5);
  const [received, setReceived] = useState({ samples: 0, peak: 0, pitch: null as number | null });
  const context = useRef<AudioContext | null>(null), gain = useRef<GainNode | null>(null), next = useRef(0), playing = useRef(false);
  const waveform = useRef<HTMLCanvasElement>(null);

  useEffect(() => { if (gain.current) gain.current.gain.value = volume; }, [volume]);
  useEffect(() => () => { void context.current?.close(); }, []);

  useEffect(() => subscribe(message => {
    if (message.deviceId !== device.id) return;
    const samples = pcmSamples(message.data);
    if (!samples.length) return;
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    setReceived(previous => ({ samples: previous.samples + samples.length, peak, pitch: peak > 300 ? pitch(samples, message.rate) : null }));
    const canvas = waveform.current, drawing = canvas?.getContext('2d');
    if (canvas && drawing) {
      drawing.clearRect(0, 0, canvas.width, canvas.height);
      drawing.beginPath();
      const visible = Math.min(samples.length, Math.round(message.rate / 50));
      for (let x = 0; x < canvas.width; x++) {
        const y = canvas.height / 2 - samples[Math.floor(x * visible / canvas.width)] / 32768 * canvas.height / 2;
        if (x) drawing.lineTo(x, y); else drawing.moveTo(x, y);
      }
      drawing.strokeStyle = getComputedStyle(canvas).color;
      drawing.stroke();
    }
    const audio = context.current;
    if (!audio || !gain.current || !playing.current) return;
    const buffer = audio.createBuffer(1, samples.length, message.rate), channel = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index++) channel[index] = samples[index] / 32768;
    // Emulator time drifts against the sound card: restart the queue rather than let latency grow.
    if (next.current < audio.currentTime || next.current > audio.currentTime + MAX_QUEUE_SECONDS) next.current = audio.currentTime + LEAD_SECONDS;
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(gain.current);
    source.start(next.current);
    next.current += buffer.duration;
  }), [device.id, subscribe]);

  async function toggle() {
    if (enabled) { playing.current = false; setEnabled(false); await context.current?.suspend(); return; }
    if (!context.current) {
      context.current = new AudioContext();
      gain.current = context.current.createGain();
      gain.current.gain.value = volume;
      gain.current.connect(context.current.destination);
    }
    await context.current.resume();
    next.current = 0;
    playing.current = true;
    setEnabled(true);
  }

  const route = speaker?.controller == null ? 'I2S not routed to these pins' : `I2S${speaker.controller}`;
  return <section className="runtime-speaker" aria-label={`${device.id} speaker`} data-device={device.id}>
    <div className="section-heading"><h2>{enabled ? <Volume2 size={17}/> : <VolumeX size={17}/>}{device.label ?? device.id}</h2><span className="meta">MAX98357A / DIN {device.din} · BCLK {device.bclk} · LRCLK {device.lrclk}</span></div>
    <div className="runtime-device-tools">
      <button type="button" aria-pressed={enabled} onClick={() => void toggle()}>{enabled ? 'Mute' : 'Play sound'}</button>
      <label>Volume <input type="range" min={0} max={1} step={0.05} value={volume} aria-label={`${device.id} volume`} onChange={event => setVolume(Number(event.target.value))}/></label>
    </div>
    <div className="speaker-view">
      <canvas ref={waveform} className="speaker-waveform" width={320} height={64} aria-label={`${device.id} waveform`}/>
      <dl className="camera-stats">
        <dt>Source</dt><dd data-speaker="route">{route}{speaker?.playing ? ' · playing' : ''}</dd>
        <dt>Format</dt><dd data-speaker="format">{speaker?.rate ? `${speaker.rate} Hz, ${speaker.bits}-bit ${speaker.mono ? 'mono' : 'stereo'}` : '--'}</dd>
        <dt>Received</dt><dd data-speaker="samples" data-samples={received.samples}>{received.samples} samples</dd>
        <dt>Level</dt><dd data-speaker="peak">{Math.round(100 * received.peak / 32768)}%</dd>
        <dt>Pitch</dt><dd data-speaker="pitch">{received.pitch ? `${Math.round(received.pitch)} Hz` : '--'}</dd>
        <dt>Underrun</dt><dd>{speaker?.underrunFrames ?? 0} frames</dd>
      </dl>
    </div>
    {speaker?.error && <p className="field-error" role="alert">{speaker.error}</p>}
  </section>;
}
