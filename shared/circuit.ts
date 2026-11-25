import type { ProjectManifest } from './manifest';
import { isSensor, PERIPHERAL_REGISTRY, type CircuitDevice } from './registry';

export type CircuitTerminal = { pin: string; signal: string; gpio: number };
export type CircuitPart = { ref: string; id: string; label: string; description: string; terminals: CircuitTerminal[] };
export type CircuitNet = { gpio: number; name: string; nodes: { ref: string; pin: string; signal: string }[] };

function signals(device: CircuitDevice, manifest: ProjectManifest): [string, number][] {
  if (isSensor(device)) {
    const bus = manifest.buses.find(bus => bus.id === device.bus);
    if (!bus) throw new Error(`Unknown I2C bus ${device.bus}`);
    return [['SDA', bus.sda], ['SCL', bus.scl]];
  }
  if ('signals' in device) return Object.entries(device.signals).filter(([, pin]) => pin >= 0).map(([name, pin]) => [name.toUpperCase(), pin]);
  if ('pins' in device) return device.pins.map((pin, index) => [['R', 'G', 'B'][index], pin]);
  if ('lrclk' in device) return [['DIN', device.din], ['BCLK', device.bclk], ['LRCLK', device.lrclk]];
  if ('din' in device) return [['DIN', device.din], ['CLK', device.clk], ['LOAD / CS', device.load]];
  return [[device.type === 'probe' ? 'PROBE' : device.type === 'ws2812b' ? 'DIN' : 'SIGNAL', device.pin]];
}

export function circuitConnections(manifest: ProjectManifest) {
  const parts: CircuitPart[] = manifest.devices.map((device, index) => ({
    ref: `J${index + 2}`, id: device.id, label: device.label ?? device.id,
    description: [
      PERIPHERAL_REGISTRY[device.type].label,
      ...(isSensor(device) ? [`${device.bus} / 0x${device.address.toString(16).padStart(2, '0')}`] : []),
      ...('length' in device ? [`${device.length} ${device.type === 'ws2812b' ? 'pixels' : 'modules'}`] : []),
      ...('size' in device ? [device.size] : []),
      ...('activeLow' in device ? [device.activeLow ? 'active-low' : 'active-high'] : []),
      ...('pullUp' in device && device.pullUp ? ['pull-up declared'] : []),
    ].join(' / '),
    terminals: signals(device, manifest).map(([signal, gpio], index) => ({ pin: String(index + 1), signal, gpio })),
  }));
  const gpios = [...new Set([...parts.flatMap(part => part.terminals.map(terminal => terminal.gpio)), ...manifest.buses.flatMap(bus => [bus.sda, bus.scl])])].sort((a, b) => a - b);
  const controller: CircuitPart = {
    ref: 'J1', id: 'esp32', label: 'ESP32', description: 'Logical GPIO terminals',
    terminals: gpios.map((gpio, index) => ({ pin: String(index + 1), signal: `GPIO${gpio}`, gpio })),
  };
  const nets: CircuitNet[] = gpios.map(gpio => {
    const bus = manifest.buses.find(bus => bus.sda === gpio || bus.scl === gpio);
    return {
      gpio, name: bus ? `${bus.id}_${bus.sda === gpio ? 'SDA' : 'SCL'}_GPIO${gpio}` : `GPIO${gpio}`,
      nodes: [controller, ...parts].flatMap(part => part.terminals.filter(terminal => terminal.gpio === gpio).map(terminal => ({ ref: part.ref, pin: terminal.pin, signal: terminal.signal }))),
    };
  });
  return { controller, parts, nets };
}
