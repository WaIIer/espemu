import { useRef, useState } from 'react';
import { Lightbulb, MousePointer2, ToggleLeft, Activity } from 'lucide-react';
import type { Peripheral, GpioInput, SessionState } from '../../shared/protocol';
import './peripherals.css';
import { digitalChannel, rgbDisplay } from '../../shared/digital-display';
import { digitalInputLevel, peripheralFamily, type DeviceType } from '../../shared/registry';
import type { ProjectState, Ws2812State } from '../../shared/runtime';
import type { Max7219State } from '../../shared/dot-matrix';
import { wiredPins } from '../../shared/registry';
import { DotMatrix } from './DotMatrix';

type Payload = { action: 'gpio-inputs'; pins: GpioInput[] };
type PinPayload = { action: 'gpio-pin'; input: GpioInput } | { action: 'gpio-momentary'; deviceId: string; pressed: boolean };
const colors = { red: '#e84f4f', green: '#32bd75', blue: '#368be6', amber: '#e6b137', white: '#e6eeee' };

type PeripheralViewState = Pick<SessionState,'epoch'|'phase'|'gpio'|'gpioWallMs'|'gpioInputs'|'peripherals'|'gpioError'> & { manifest?: ProjectState['manifest']; ws2812?: Ws2812State|null; max7219?: Max7219State|null };
export function PeripheralsPanel({ state, disabled, send, sendPin, filter, disconnected }: { state: PeripheralViewState | null; disabled: boolean; send: (payload: Payload, epoch?: number) => Promise<void>; sendPin?: (payload: PinPayload, epoch?: number) => Promise<void>; filter?: ReadonlySet<string>; disconnected?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const held = useRef(new Set<number>());
  const devices = (state?.peripherals ?? []).filter(device=>!filter||filter.has(device.id));
  const stale = disconnected || !state?.gpio || (state.phase !== 'paused' && (state.phase !== 'running' || Date.now() - (state.gpioWallMs ?? 0) > 2500));
  async function perform(payload: Payload | PinPayload) {
    setError(null);
    try {
      if (payload.action === 'gpio-inputs') await send(payload, state?.epoch);
      else await sendPin?.(payload, state?.epoch);
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The device command failed'); }
  }
  function level(pin: number, requested: 0 | 1 | null) {
    if (sendPin) { void perform({ action: 'gpio-pin', input: { pin, level: requested } }); return; }
    const next = (state?.gpioInputs ?? []).filter(entry => entry.pin !== pin);
    next.push({ pin, level: requested });
    void perform({ action: 'gpio-inputs', pins: next });
  }
  function press(device: Peripheral & { pin: number }, down: boolean) {
    if (held.current.has(device.pin) === down) return;
    if (down) held.current.add(device.pin); else held.current.delete(device.pin);
    if (sendPin) void perform({ action: 'gpio-momentary', deviceId: device.id, pressed: down });
    else level(device.pin, digitalInputLevel(device.kind as DeviceType, device.activeLow, down, 'pullUp' in device && device.pullUp === true));
  }
  return <section className="peripheral-panel" aria-label="GPIO devices">
    <div className="peripheral-toolbar"><h2><Lightbulb size={17} />Devices</h2></div>
    {(error || state?.gpioError) && <div role="alert" className="field-error">{error ?? state?.gpioError}</div>}
    {state?.ws2812?.error&&<div role="alert" className="field-error">{state.ws2812.error}</div>}
    <div className="peripheral-grid">{devices.map(original => {
      const declaration=state?.manifest?.devices.find(entry=>entry.id===original.id);
      const device=declaration?{...original,label:declaration.label??declaration.id}:original;
      const family = peripheralFamily(device.kind as DeviceType);
  const pins = wiredPins(device);
      const pin = pins[0];
      const observations = pins.map(pin => state?.gpio?.pins.find(entry => entry.pin === pin));
      const channels = pins.map(pin=>digitalChannel(state?.gpio,pin,device.activeLow));
      const rgb = device.kind==='rgb'?rgbDisplay(state?.gpio,device.pins,device.activeLow):null;
      const decoded = device.kind==='ws2812b'?state?.ws2812?.devices.find(entry=>entry.id===device.id):undefined;
      const on = channels.map(channel=>channel.on);
      const driven = observations.some(pin => pin?.outputEnabled);
      const lit = on.some(Boolean);
      const rgbColor = `rgb(${on[0] ? 235 : 0},${on[1] ? 200 : 0},${on[2] ? 235 : 0})`;
      const inputLevel = observations[0]?.level;
      return <article className={`peripheral-device ${device.kind === 'max7219' ? 'matrix-device' : ''} ${stale ? 'peripheral-stale' : ''}`} aria-label={`${device.label} peripheral`} data-device={device.id} key={device.id}>
        <div className="peripheral-heading"><h3>{device.label}</h3></div>
        <div className="peripheral-body">{family === 'led' || family === 'rgb' ? <>
          <div role="img" aria-label={`${device.label} ${driven ? lit ? 'on' : 'off' : 'undriven'}`} className={`led-indicator ${lit && !stale ? 'led-on' : ''}`} style={{ backgroundColor: lit ? device.kind === 'led' ? colors[device.color] : rgbColor : '#d9e0dc' }} />
          <strong className="pin-state" title={!driven?'Firmware has not enabled this GPIO output':undefined}>{rgb?.status==='partial'?'PARTIAL OUTPUT':!driven ? 'UNDRIVEN' : lit ? 'ON' : 'OFF'}</strong></>
          : device.kind==='max7219'?<DotMatrix device={device} state={state?.max7219}/>
          : device.kind==='ws2812b'?<div className={`ws2812-grid ${device.length===1?'ws2812-single':''}`} role="group" aria-label={`${device.label} pixels`}>{Array.from({length:device.length},(_,index)=>{
            const pixel=decoded?.pixels[index];return <span key={index} className="ws2812-pixel" role="img" data-pixel={index} data-rgb={pixel?.join(',')??'unavailable'} aria-label={`${device.label} pixel ${index} ${pixel?pixel.join(','):'unavailable'}`} title={pixel?`${index}: R ${pixel[0]}, G ${pixel[1]}, B ${pixel[2]}`:'Model state unavailable'} style={{backgroundColor:pixel?`rgb(${pixel.join(',')})`:'var(--line)'}}/>;
          })}</div>
          : family === 'button' ? <button className="physical-button" aria-label={`Press ${device.label}`} disabled={disabled || !state?.gpio} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); press(device as Peripheral & {pin:number}, true); }} onPointerUp={() => press(device as Peripheral & {pin:number}, false)} onPointerCancel={() => press(device as Peripheral & {pin:number}, false)} onLostPointerCapture={() => { if (held.current.has(pin)) press(device as Peripheral & {pin:number}, false); }} onBlur={() => { if (held.current.has(pin)) press(device as Peripheral & {pin:number}, false); }} onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); press(device as Peripheral & {pin:number}, true); } }} onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); press(device as Peripheral & {pin:number}, false); } }}><MousePointer2 size={20} /></button>
          : family === 'switch' ? <label className="gpio-switch"><ToggleLeft size={22} /><input aria-label={`Toggle ${device.label}`} type="checkbox" checked={inputLevel === (device.activeLow ? 0 : 1)} disabled={disabled || !state?.gpio} onChange={event => level(pin, digitalInputLevel(device.kind as DeviceType, device.activeLow, event.target.checked, 'pullUp' in device && device.pullUp === true))} /></label>
          : <><Activity size={25} /><strong className="pin-state">{inputLevel == null ? '?' : inputLevel ? 'HIGH' : 'LOW'}</strong></>}
          {family !== 'led' && family !== 'rgb' && family !== 'ws2812b' && family !== 'matrix' && (family !== 'probe' && pin >= 34 && observations[0] && !observations[0].externallyDriven
            ? <span className="pin-state" title="Nothing drives this pin and it has no pull resistor. GPIO34 to GPIO39 have no internal pulls. Set &quot;pullUp&quot;: true for a module or board pull-up.">FLOATING</span>
            : <span className="pin-state">{inputLevel == null ? '?' : `PIN ${inputLevel}`}</span>)}
        </div>
        {device.kind==='rgb'&&<div className="rgb-channel-states">{channels.map((channel,index)=><span key={index} title={`GPIO${channel.pin}: ${channel.status==='input'?'configured as input':channel.status}`} data-gpio-channel={['red','green','blue'][index]}>{['R','G','B'][index]} {channel.status.toUpperCase()}</span>)}</div>}
        <div className="peripheral-wiring">{pins.map((pin,index)=><span key={index}>{device.kind==='rgb'?`${['R','G','B'][index]} `:device.kind==='max7219'?`${['DIN','CLK','LOAD'][index]} `:''}GPIO{pin}</span>)}</div>
        <span className="meta peripheral-identity">{device.id} / {device.kind}{stale?' / Stale or unavailable':''}</span>
        <div className="peripheral-settings">{device.kind==='max7219'?<span>{device.length} × 8×8 / MAX7219 serial</span>:device.kind==='ws2812b'?<span>{device.length} {device.length===1?'pixel':'pixels'}</span>:<span>{device.activeLow?'Active low':'Active high'}{'pullUp' in device && device.pullUp?' / pull-up':''}</span>}</div>
        {observations.some(pin => pin?.contended) && <span className="field-error">Conflicting external drive</span>}
      </article>;
    })}</div>
  </section>;
}
