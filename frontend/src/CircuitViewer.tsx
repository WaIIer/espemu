import { useEffect, useRef, useState } from 'react';
import { Cpu, Download, Minus, Plus, RotateCcw } from 'lucide-react';
import { circuitConnections, exportKicadNetlist } from '../../shared/circuit';
import type { ProjectManifest } from '../../shared/manifest';
import './circuit.css';

const colors = ['#087f8c', '#a65c00', '#7954b3', '#287b45', '#c34565', '#326dc0'];

export function CircuitViewer({ manifest, visibleDevices, inspect }: {
  manifest: ProjectManifest; visibleDevices: Set<string>; inspect: (id: string) => void;
}) {
  const { controller, parts, nets } = circuitConnections(manifest);
  const [selected, setSelected] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const scroll = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(() => matchMedia('(max-width:600px)').matches);
  useEffect(() => {
    const media = matchMedia('(max-width:600px)');
    const resize = () => setCompact(media.matches);
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, []);
  const cardX = 330 + nets.length * 12;
  const cardWidth = compact ? 240 : 336;
  const headerHeight = compact ? 156 : 128;
  const width = cardX + cardWidth + 24;
  let bottom = 36;
  const cards = parts.map(part => {
    const y = bottom;
    const height = headerHeight + part.terminals.length * 28 + 16;
    bottom += height + 24;
    return { part, y, height };
  });
  const height = Math.max(bottom, 160 + nets.length * 28, 260);
  const relevant = new Set(parts.filter(part => visibleDevices.has(part.id)).flatMap(part => part.terminals.map(port => port.gpio)));
  const focused = (gpio: number) => selected === null ? relevant.has(gpio) || !parts.length : selected === gpio;
  function resetView() {
    setZoom(1); setSelected(null);
    scroll.current?.scrollTo({ top: 0, left: 0 });
  }
  function download() {
    const url = URL.createObjectURL(new Blob([exportKicadNetlist(manifest)], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = 'espemu.net'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className="runtime-circuit circuit-viewer" aria-label="Circuit wiring">
    <div className="section-heading"><h2><Cpu size={17}/>Circuit wiring</h2><span className="meta">{parts.length} devices / {nets.length} signal nets</span></div>
    <div className="circuit-toolbar">
      <label>Trace signal <select aria-label="Trace circuit signal" value={selected ?? ''} onChange={event => setSelected(event.target.value === '' ? null : Number(event.target.value))}>
        <option value="">All connections</option>{nets.map(net => <option key={net.gpio} value={net.gpio}>{net.name}</option>)}
      </select></label>
      <div className="circuit-zoom">
        <button aria-label="Zoom out circuit" disabled={zoom <= .5} onClick={() => setZoom(value => value - .25)}><Minus size={16}/></button>
        <span>{Math.round(zoom * 100)}%</span>
        <button aria-label="Zoom in circuit" disabled={zoom >= 2} onClick={() => setZoom(value => value + .25)}><Plus size={16}/></button>
        <button aria-label="Reset circuit view" title="Reset zoom, scroll and signal trace" onClick={resetView}><RotateCcw size={16}/></button>
      </div>
      <button className="circuit-export" title="Export logical signal connections, not a physical PCB design" onClick={download}><Download size={16}/>KiCad netlist</button>
    </div>
    <p className="meta circuit-note">The diagram shows the declared signal wiring. Dots mark wire connections. Other wire crossings stay separate. Scroll to view the circuit or select a signal to trace it.</p>
    {manifest.buses.map(bus => <p className="meta" key={bus.id}>{bus.id}: I2C{bus.controller} / SDA GPIO{bus.sda} / SCL GPIO{bus.scl} / {bus.frequencyHz / 1000} kHz</p>)}
    {!parts.length && <p className="meta">No devices declared.{nets.length ? ' The I2C bus has no attached devices.' : ''}</p>}
    <div className="circuit-scroll" ref={scroll} tabIndex={0} role="region" aria-label="Scrollable circuit diagram">
      <svg className="circuit-diagram" width={width * zoom} height={height * zoom} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Declared ESP32 signal connections">
        <rect className="circuit-board" x="24" y="36" width="200" height={112 + nets.length * 28} rx="10"/>
        <text className="circuit-controller" x="44" y="72">ESP32</text>
        <text className="circuit-caption" x="44" y="96">GPIO signal terminals</text>
        <text className="circuit-caption" x="44" y="116">Not package pin numbers</text>
        {nets.map((net, index) => {
          const x = 270 + index * 12, y = 148 + index * 28;
          const endpoints = cards.flatMap(card => card.part.terminals.flatMap((port, index) => port.gpio === net.gpio ? [{ y: card.y + headerHeight + index * 28, ref: card.part.ref }] : []));
          const endY = Math.max(y, ...endpoints.map(point => point.y));
          const startY = Math.min(y, ...endpoints.map(point => point.y));
          return <g key={net.gpio} className={`circuit-net${focused(net.gpio) ? '' : ' circuit-dim'}`} data-gpio={net.gpio}>
            <title>{net.name}: {net.nodes.map(node => `${node.ref}.${node.signal}`).join(', ')}</title>
            <text className="circuit-pin-label" x="208" y={y + 4} textAnchor="end">GPIO{net.gpio}</text>
            <path d={`M224 ${y} H${x} M${x} ${startY} V${endY}`} stroke={colors[index % colors.length]}/>
            <circle cx="224" cy={y} r="4" fill={colors[index % colors.length]}/>
            <circle cx={x} cy={y} r="4" fill={colors[index % colors.length]}/>
            {endpoints.map(point => <g key={point.ref}>
              <path d={`M${x} ${point.y} H${cardX}`} stroke={colors[index % colors.length]}/>
              <circle cx={x} cy={point.y} r="4" fill={colors[index % colors.length]}/>
            </g>)}
          </g>;
        })}
        {cards.map(({ part, y, height }, index) => <g key={part.ref} className={`circuit-component${visibleDevices.has(part.id) && (selected === null || part.terminals.some(port => port.gpio === selected)) ? '' : ' circuit-dim'}`} data-device-id={part.id}>
          <rect className="circuit-card" x={cardX} y={y} width={cardWidth} height={height} rx="8"/>
          <foreignObject x={cardX + 16} y={y + 12} width={cardWidth - 32} height={headerHeight - 22}>
            <div className="circuit-card-heading"><button onClick={() => inspect(part.id)} title={`Inspect ${part.label}`}>{part.label}</button>
              <span>{part.id} / {manifest.devices[index].type.toUpperCase()}</span>
              <span>{'address' in manifest.devices[index] ? `${manifest.devices[index].bus} / 0x${manifest.devices[index].address.toString(16).padStart(2, '0')}` : 'activeLow' in manifest.devices[index] ? manifest.devices[index].activeLow ? 'Active-low' : 'Active-high' : 'Digital signals'}</span>
            </div>
          </foreignObject>
          {part.terminals.map((port, index) => <g key={port.pin}>
            <circle cx={cardX} cy={y + headerHeight + index * 28} r="4" className="circuit-terminal"/>
            <text className="circuit-signal-label" x={cardX + 16} y={y + headerHeight + 4 + index * 28}>{port.signal}</text>
            <text className="circuit-gpio-label" x={cardX + cardWidth - 18} y={y + headerHeight + 4 + index * 28} textAnchor="end">GPIO{port.gpio}</text>
          </g>)}
        </g>)}
      </svg>
    </div>
    {selected !== null && <div className="circuit-trace" role="status"><b>{nets.find(net => net.gpio === selected)?.name}</b>
      {parts.filter(part => part.terminals.some(port => port.gpio === selected)).map(part => <span key={part.ref}>{part.label}: {part.terminals.filter(port => port.gpio === selected).map(port => port.signal).join(', ')}</span>)}
    </div>}
    <details><summary>Wiring reference and export pin mapping</summary>
      <p className="meta">KiCad export uses generic connectors. J1 represents ESP32 GPIOs. J2 onward represent devices. The numbers below identify logical terminals. Map them to physical pads and assign footprints yourself. Add power, ground, pull-ups and protection before making hardware.</p>
      {[controller, ...parts.filter(part => visibleDevices.has(part.id))].map(part => <article className="circuit-reference" key={part.ref}>
        <b>{part.ref} / {part.label}</b><span className="meta">{part.id} / {part.description}</span>
        <div>{part.terminals.map(port => <span key={port.pin}>{port.pin}: {port.signal} on GPIO{port.gpio}</span>)}</div>
      </article>)}
    </details>
  </section>;
}
