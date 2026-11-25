import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ProjectManifestSchema, type ProjectManifest } from '../shared/manifest.ts';
import { isSensor, type DeviceType } from '../shared/registry.ts';
import { kicadOmission } from '../shared/kicad-support.ts';

const pinSchema = z.object({ number: z.string(), name: z.string(), type: z.string(), x: z.number(), y: z.number(), angle: z.number() });
const symbolSchema = z.object({ symbol: z.string(), pins: z.array(pinSchema), reference: z.string(), footprint: z.string(), datasheet: z.string() });
const symbols = z.record(symbolSchema).parse(JSON.parse(readFileSync(new URL('./kicad/symbols.json', import.meta.url), 'utf8')));
symbols['ESPEmu:A3144UA'] = {
  reference: 'U', footprint: '', datasheet: 'https://www.allegromicro.com/~/media/files/datasheets/a3141-2-3-4-datasheet.ashx',
  pins: [
    { number: '1', name: 'VCC', type: 'power_in', x: 0, y: 7.62, angle: 270 },
    { number: '2', name: 'GND', type: 'power_in', x: 0, y: -7.62, angle: 90 },
    { number: '3', name: 'OUT', type: 'open_collector', x: 10.16, y: 0, angle: 180 },
  ],
  symbol: `(symbol "A3144UA" (in_bom yes) (on_board yes)
    (property "Reference" "U" (at -5.08 6.35 0) (effects (font (size 1.27 1.27))))
    (property "Value" "A3144UA" (at 5.08 6.35 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "A3144UA_0_1"
      (rectangle (start -5.08 5.08) (end 5.08 -5.08) (stroke (width 0.254) (type default)) (fill (type background))))
    (symbol "A3144UA_1_1"
      (pin power_in line (at 0 7.62 270) (length 2.54) (name "VCC" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin power_in line (at 0 -7.62 90) (length 2.54) (name "GND" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
      (pin open_collector line (at 10.16 0 180) (length 5.08) (name "OUT" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27)))))))`,
};
const libraryLicense = readFileSync(new URL('./kicad/LICENSE.kicad-symbols', import.meta.url), 'utf8');
const uuid = (key: string) => {
  const value = createHash('sha256').update(`espemu-kicad/${key}`).digest('hex').slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};
const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\t]/g, ' ')}"`;
const number = (value: number) => Number(value.toFixed(4));
const effects = '(effects (font (size 1 1)))';
const rootUuid = uuid('root');
const rail = '+3V3';
const gpio = (pin: number) => `GPIO${pin}`;
const passiveFootprint = (kind: 'R' | 'C') => `${kind === 'R' ? 'Resistor' : 'Capacitor'}_SMD:${kind}_0603_1608Metric`;

type Component = {
  reference: string; symbol: string; value: string; footprint: string; datasheet: string;
  instance: string; purpose: string; nets: Record<string, string | null>;
};
type Sheet = { filename: string; title: string; key: string; components: Component[]; notes: string[] };
type DeviceResult = { id: string; type: DeviceType; status: 'included' | 'omitted'; reason: string; sheet?: string; references: string[] };

function renderSheet(sheet: Sheet, root: boolean, children: Sheet[]): string {
  const sheetUuid = root ? rootUuid : uuid(sheet.key);
  const path = root ? `/${rootUuid}` : `/${rootUuid}/${sheetUuid}`;
  const used = [...new Set(sheet.components.map(component => component.symbol))];
  const lines = [
    '(kicad_sch (version 20230121) (generator eeschema)',
    `(uuid ${sheetUuid}) (paper "${root ? 'A3' : 'A4'}")`,
    `(title_block (title ${quote(sheet.title)}) (comment 1 "Review layout, power and omitted devices before manufacture."))`,
    `(lib_symbols ${used.map(id => symbols[id].symbol.replace(/^\(symbol "[^"]+"/, `(symbol ${quote(id)}`)).join('\n')})`,
  ];
  for (const [index, component] of sheet.components.entries()) {
    const data = symbols[component.symbol];
    const x = root ? index === 0 ? 60.96 : 139.7 + ((index - 1) % 4) * 60.96 : 60.96 + (index % 3) * 76.2;
    const y = root ? index === 0 ? 96.52 : 43.18 + Math.floor((index - 1) / 4) * 35.56 : 66.04 + Math.floor(index / 3) * 60.96;
    const id = uuid(`${sheet.key}/${component.reference}`);
    const visibleProperty = (name: string, value: string) => {
      const position = data.symbol.match(new RegExp(`\\(property "${name}" "[^"]*" \\(at ([\\d.-]+) ([\\d.-]+) ([\\d.-]+)\\)`));
      if (!position) throw new Error(`Missing ${name} placement in ${component.symbol}`);
      return `(property ${quote(name)} ${quote(value)} (at ${number(x + Number(position[1]))} ${number(y - Number(position[2]))} ${position[3]}) (effects (font (size 1 1)) (justify left)))`;
    };
    const properties = [
      visibleProperty('Reference', component.reference),
      visibleProperty('Value', component.value),
      ...[['Footprint', component.footprint], ['Datasheet', component.datasheet], ['ESPEmu_Instance', component.instance], ['Purpose', component.purpose]]
        .map(([name, value]) => `(property ${quote(name)} ${quote(value)} (at ${x} ${y} 0) (effects (font (size 1 1)) hide))`),
    ];
    lines.push(`(symbol (lib_id ${quote(component.symbol)}) (at ${x} ${y} 0) (unit 1) (in_bom ${component.symbol === 'power:PWR_FLAG' ? 'no' : 'yes'}) (on_board yes) (uuid ${id})
      ${properties.join('\n')}
      ${data.pins.map(pin => `(pin ${quote(pin.number)} (uuid ${uuid(`${id}/${pin.number}`)}))`).join('\n')}
      (instances (project "espemu" (path ${quote(path)} (reference ${quote(component.reference)}) (unit 1)))))`);
    const connectedPositions = new Map<string, string | null>();
    for (const pin of data.pins) {
      if (!Object.hasOwn(component.nets, pin.number)) throw new Error(`${component.reference}: missing disposition for pin ${pin.number}`);
      const net = component.nets[pin.number];
      const px = number(x + pin.x), py = number(y - pin.y);
      const position = `${px}/${py}`;
      if (connectedPositions.has(position)) {
        if (connectedPositions.get(position) !== net) throw new Error(`${component.reference}: incompatible stacked pins at ${position}`);
        continue;
      }
      connectedPositions.set(position, net);
      if (net === null) {
        lines.push(`(no_connect (at ${px} ${py}) (uuid ${uuid(`${id}/${position}/nc`)}))`);
        continue;
      }
      // KiCad's library Y axis points up, while schematic Y points down.
      const radians = pin.angle * Math.PI / 180;
      const lx = number(px - Math.cos(radians) * 5.08), ly = number(py + Math.sin(radians) * 5.08);
      const labelAngle = (pin.angle + 180) % 360;
      lines.push(`(wire (pts (xy ${px} ${py}) (xy ${lx} ${ly})) (stroke (width 0) (type default)) (uuid ${uuid(`${id}/${position}/wire`)}))`);
      lines.push(`(global_label ${quote(net)} (shape bidirectional) (at ${lx} ${ly} ${labelAngle}) (effects (font (size 1 1)) (justify ${labelAngle >= 180 ? 'right' : 'left'})) (uuid ${uuid(`${id}/${position}/label`)}))`);
    }
  }
  for (const [index, child] of children.entries()) {
    const x = 30.48 + (index % 4) * 63.5, y = 177.8 + Math.floor(index / 4) * 12.7;
    lines.push(`(sheet (at ${x} ${y}) (size 55.88 7.62) (fields_autoplaced)
      (stroke (width 0.1524) (type default)) (fill (color 0 0 0 0)) (uuid ${uuid(child.key)})
      (property "Sheetname" ${quote(child.title.length > 40 ? child.title.slice(0, 37) + '...' : child.title)} (at ${x} ${number(y - 1.27)} 0) (effects (font (size 1 1)) (justify left)))
      (property "Sheetfile" ${quote(child.filename)} (at ${x} ${number(y + 8.89)} 0) (effects (font (size 1 1)) hide))
      (instances (project "espemu" (path ${quote(`/${rootUuid}`)} (page ${quote(String(index + 2))})))))`);
  }
  for (const [index, note] of sheet.notes.entries()) {
    const linesOfNote = note.match(/.{1,100}(?:\s|$)/g) ?? [note];
    for (const [line, text] of linesOfNote.entries()) lines.push(`(text ${quote(text.trim())} (at 25.4 ${root ? 20.32 + index * 5.08 + line * 3.81 : 157.48 + index * 12.7 + line * 3.81} 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid ${uuid(`${sheet.key}/note/${index}/${line}`)}))`);
  }
  if (root) lines.push(`(sheet_instances (path "/" (page "1")))`);
  lines.push(')');
  return lines.join('\n') + '\n';
}

export function kicadProjectFiles(value: ProjectManifest): Record<string, string> {
  const manifest = ProjectManifestSchema.parse(value);
  const counters: Record<string, number> = {};
  const add = (sheet: Sheet, symbol: string, nets: Record<string, string | null>, purpose: string, instance = '', value?: string, footprint?: string) => {
    const data = symbols[symbol];
    if (!data) throw new Error(`Unqualified KiCad symbol: ${symbol}`);
    const prefix = data.reference;
    const reference = `${prefix}${counters[prefix] = (counters[prefix] ?? 0) + 1}`;
    const component: Component = { reference, symbol, value: value ?? symbol.split(':')[1], footprint: footprint ?? data.footprint, datasheet: data.datasheet, instance, purpose, nets };
    sheet.components.push(component);
    return reference;
  };
  const passive = (sheet: Sheet, kind: 'R' | 'C', value: string, a: string, b: string, purpose: string, instance = '') =>
    add(sheet, `Device:${kind}`, { 1: a, 2: b }, purpose, instance, value, passiveFootprint(kind));
  const capacitor = (sheet: Sheet, value: string, net: string, purpose: string, instance = '') =>
    passive(sheet, 'C', value, net, 'GND', purpose, instance);
  const root: Sheet = { filename: 'espemu.kicad_sch', title: 'ESPEmu - ESP32-WROOM-32 / externally regulated 3.3 V', key: 'root', components: [], notes: [] };
  const sheets: Sheet[] = [];
  const results: DeviceResult[] = [];
  const usedGpios = new Set<number>();

  for (const [index, device] of manifest.devices.entries()) {
    const reason = kicadOmission(device);
    if (reason) {
      results.push({ id: device.id, type: device.type, status: 'omitted', reason, references: [] });
      continue;
    }
    const sheet: Sheet = { filename: `device-${index + 1}-${device.id}.kicad_sch`, key: `device/${device.id}`, title: `${device.id} - ${device.type}`, components: [], notes: [] };
    const local = (name: string) => `D${index + 1}_${name}`;
    const insert = (symbol: string, nets: Record<string, string | null>, purpose: string) => add(sheet, symbol, nets, purpose, device.id);
    const cap = (value: string, net: string, purpose: string) => capacitor(sheet, value, net, purpose, device.id);
    const resistor = (value: string, a: string, b: string, purpose: string) => passive(sheet, 'R', value, a, b, purpose, device.id);
    if (isSensor(device)) {
      const bus = manifest.buses.find(bus => bus.id === device.bus)!;
      const sda = gpio(bus.sda), scl = gpio(bus.scl);
      usedGpios.add(bus.sda); usedGpios.add(bus.scl);
      if (device.type === 'bme280') {
        insert('Sensor:BME280', { 1: 'GND', 2: rail, 3: sda, 4: scl, 5: device.address === 0x76 ? 'GND' : rail, 6: rail, 7: 'GND', 8: rail }, 'Bare BME280, I2C selected by CSB=VDDIO; SDO selects the manifest address');
        cap('100nF 10V X7R', rail, 'VDD bypass: place next to pin 8');
        cap('100nF 10V X7R', rail, 'VDDIO bypass: place next to pin 6');
        sheet.notes.push('Bosch BME280 datasheet, sections 6.1 and 7: CSB directly to VDDIO; SDO low=0x76, high=0x77; separate 100 nF bypass capacitors.');
      } else if (device.type === 'sht3x') {
        insert('Sensor_Humidity:SHT31-DIS', { 1: sda, 2: device.address === 0x44 ? 'GND' : rail, 3: null, 4: scl, 5: rail, 6: null, 7: 'GND', 8: 'GND', 9: 'GND' }, 'Concrete SHT31-DIS implementation of the SHT3x family; unused ALERT and nRESET left floating');
        cap('100nF 10V X7R', rail, 'VDD bypass: place next to pin 5');
        sheet.notes.push('Sensirion SHT3x-DIS datasheet, pin assignment and application circuit: ADDR low=0x44, high=0x45; pin 7 and exposed pad to VSS; unused ALERT/nRESET left floating.');
      } else if (device.type === 'mpu6050') {
        insert('Sensor_Motion:MPU-6050', {
          1: 'GND', 2: null, 3: null, 4: null, 5: null, 6: null, 7: null, 8: rail,
          9: device.address === 0x68 ? 'GND' : rail, 10: local('REGOUT'), 11: 'GND', 12: null, 13: rail,
          14: null, 15: null, 16: null, 17: null, 18: 'GND', 19: null, 20: local('CPOUT'),
          21: null, 22: null, 23: scl, 24: sda,
        }, 'Bare MPU-6050; internal clock, no external frame sync or auxiliary sensor');
        cap('100nF 10V X7R', rail, 'VDD bypass: place next to pin 13');
        cap('10nF 10V X7R', rail, 'VLOGIC bypass: place next to pin 8');
        cap('100nF 10V X7R', local('REGOUT'), 'REGOUT filter: pin 10 to GND only, not to VDD');
        cap('2.2nF 50V X7R 10%', local('CPOUT'), 'Charge-pump capacitor: pin 20 to GND only');
        sheet.notes.push('InvenSense MPU-6000/MPU-6050 product specification, sections 7.1-7.2: AD0 selects 0x68/0x69; VLOGIC=VDD; REGOUT 100 nF, CPOUT 2.2 nF/50 V, VDD 100 nF, VLOGIC 10 nF.');
      } else {
        throw new Error(`Missing electrical profile for ${device.type}`);
      }
    } else if (device.type === 'a3144') {
      usedGpios.add(device.pin);
      insert('ESPEmu:A3144UA', { 1: '+5V', 2: 'GND', 3: gpio(device.pin) }, 'Allegro A3144UA bare Hall switch; active-low open-collector output');
      cap('100nF 10V X7R', '+5V', 'Hall sensor supply bypass: place next to pin 1');
      resistor('10k', rail, gpio(device.pin), 'Pull output up to ESP32 3.3 V, never to the sensor 5 V supply');
      sheet.notes.push('Allegro A3141/2/3/4 datasheet: supply 4.5-24 V; pin 1 VCC, pin 2 GND, pin 3 open-collector OUT. Supply externally regulated 5 V, with common ground; use a 3.3 V pull-up.');
    } else if (device.type === 'led') {
      usedGpios.add(device.pin);
      insert('Device:LED', { 1: device.activeLow ? local('LED') : 'GND', 2: device.activeLow ? rail : local('LED') }, 'Low-current indicator; select the desired color and verify forward voltage');
      resistor('1k', gpio(device.pin), local('LED'), 'LED current limit; maximum less than 3.3 mA');
    } else if (device.type === 'rgb') {
      device.pins.forEach(pin => usedGpios.add(pin));
      insert(device.activeLow ? 'Device:LED_RAGB' : 'Device:LED_RKGB', { 1: local('RED'), 2: device.activeLow ? rail : 'GND', 3: local('GREEN'), 4: local('BLUE') }, 'RGB LED: pin order red/common/green/blue; select a matching physical part');
      device.pins.forEach((pin, channel) => resistor('1k', gpio(pin), local(['RED', 'GREEN', 'BLUE'][channel]), 'Independent channel current limit'));
    } else if (device.type === 'button' || device.type === 'switch') {
      usedGpios.add(device.pin);
      insert(device.type === 'button' ? 'Switch:SW_Push' : 'Switch:SW_SPST', { 1: gpio(device.pin), 2: device.activeLow ? 'GND' : rail }, 'Contact to the asserted rail');
      resistor('10k', gpio(device.pin), device.activeLow ? rail : 'GND', 'External inactive-state bias, including on input-only GPIOs');
    } else if (device.type === 'probe') {
      usedGpios.add(device.pin);
      insert('Connector:TestPoint', { 1: gpio(device.pin) }, 'Passive observation point, not an additional driver');
    } else {
      throw new Error(`Missing electrical profile for ${device.type}`);
    }
    sheets.push(sheet);
    results.push({ id: device.id, type: device.type, status: 'included', reason: sheet.notes.join(' ') || 'Explicit 3.3 V GPIO circuit; see component purposes and footprint-selection warnings.', sheet: sheet.filename, references: sheet.components.map(component => component.reference) });
  }

  const modulePins: Record<string, string | null> = Object.fromEntries(symbols['RF_Module:ESP32-WROOM-32'].pins.map(pin => [pin.number, null]));
  Object.assign(modulePins, { 1: 'GND', 2: rail, 3: 'EN', 15: 'GND', 25: 'GPIO0', 34: 'GPIO3', 35: 'GPIO1', 38: 'GND', 39: 'GND' });
  const moduleGpios: Record<number, string> = { 0: '25', 1: '35', 2: '24', 3: '34', 4: '26', 5: '29', 12: '14', 13: '16', 14: '13', 15: '23', 16: '27', 17: '28', 18: '30', 19: '31', 21: '33', 22: '36', 23: '37', 25: '10', 26: '11', 27: '12', 32: '8', 33: '9', 34: '6', 35: '7', 36: '4', 39: '5' };
  for (const pin of usedGpios) {
    if (!moduleGpios[pin]) throw new Error(`GPIO${pin} is unavailable on ESP32-WROOM-32`);
    modulePins[moduleGpios[pin]] = gpio(pin);
  }
  add(root, 'RF_Module:ESP32-WROOM-32', modulePins, 'ESP32 module with internal flash/crystal/RF network; keep antenna area clear');
  add(root, 'Connector_Generic:Conn_01x02', { 1: rail, 2: 'GND' }, 'Externally regulated 3.3 V input, at least 500 mA; never apply 5 V', '', '3.3V INPUT', 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical');
  capacitor(root, '10uF 10V X5R', rail, 'ESP32 local bulk decoupling; verify effective capacitance at 3.3 V');
  capacitor(root, '100nF 10V X7R', rail, 'ESP32 VDD bypass: place next to module pin 2');
  passive(root, 'R', '10k', rail, 'EN', 'Enable pull-up');
  capacitor(root, '1uF 10V X7R', 'EN', 'Enable power-on RC delay; verify supply rise time');
  passive(root, 'R', '10k', rail, 'GPIO0', 'Normal boot pull-up');
  add(root, 'Switch:SW_Push', { 1: 'EN', 2: 'GND' }, 'Manual reset', '', 'RESET');
  add(root, 'Switch:SW_Push', { 1: 'GPIO0', 2: 'GND' }, 'Hold during reset to enter serial bootloader', '', 'BOOT');
  add(root, 'Connector_Generic:Conn_01x06', { 1: rail, 2: 'GND', 3: 'GPIO1', 4: 'GPIO3', 5: 'EN', 6: 'GPIO0' }, '3.3 V UART programmer: TX from ESP32, RX into ESP32; do not connect a second power source', '', 'UART / RESET / BOOT', 'Connector_PinHeader_2.54mm:PinHeader_1x06_P2.54mm_Vertical');
  if (sheets.some(sheet => sheet.components.some(component => ['Sensor:BME280', 'Sensor_Humidity:SHT31-DIS', 'Sensor_Motion:MPU-6050'].includes(component.symbol)))) {
    passive(root, 'R', '2.2k', rail, 'GPIO21', 'One shared I2C SDA pull-up, never one per sensor');
    passive(root, 'R', '2.2k', rail, 'GPIO22', 'One shared I2C SCL pull-up, never one per sensor');
  }
  const usesFiveVolts = sheets.some(sheet => sheet.components.some(component => component.symbol === 'ESPEmu:A3144UA'));
  if (usesFiveVolts) {
    add(root, 'Connector_Generic:Conn_01x02', { 1: '+5V', 2: 'GND' }, 'Externally regulated 5 V for Hall sensors, at least 10 mA per sensor; common ground with 3.3 V input', '', '5V HALL INPUT', 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical');
    add(root, 'power:PWR_FLAG', { 1: '+5V' }, 'Separate external 5 V sensor supply is the source');
  }
  add(root, 'power:PWR_FLAG', { 1: rail }, 'External regulated supply is the source');
  add(root, 'power:PWR_FLAG', { 1: 'GND' }, 'External supply ground');

  const components = [root, ...sheets].flatMap(sheet => sheet.components);
  root.notes.push(results.some(result => result.status === 'omitted')
    ? 'PARTIAL CIRCUIT: devices were omitted. Read export-report.json for every omission before using this design.'
    : 'Read export-report.json and README.txt for power, bypass placement and footprint requirements.');
  const warnings = [
    'This is a reviewable schematic, not a production-qualified PCB. No routing, thermal, EMC, enclosure or real-hardware validation is implied.',
    'Supply the ESP32 input with externally regulated 3.3 V (at least 500 mA plus peripheral load). No regulator or battery circuit is inferred; never apply 5 V to the ESP32 supply.',
    ...(usesFiveVolts ? ['A3144UA requires the separate 5 V HALL INPUT (at least 10 mA per Hall sensor). Join supply grounds; the sensor output pull-up remains on 3.3 V. Never connect the 5 V input to the ESP32 supply.'] : []),
    'Place each bypass capacitor at the pin named in its Purpose; keep the ESP32 antenna keepout and sensor environmental/mechanical requirements.',
    '2.2k I2C pull-ups assume <=160 pF at 400 kHz or <=400 pF at 100 kHz. Account for wiring, device and probe capacitance; do not add module pull-ups in parallel.',
    'ESP32 strapping GPIO0/2/5/12/15 peripherals are omitted until their power-on loading is qualified. GPIO37/38 are not exposed on WROOM-32.',
    'Disconnect UART programmer signal drives when GPIO1/3 are used by a peripheral. The UART header carries 3.3 V logic only.',
    ...components.filter(component => !component.footprint && component.symbol !== 'power:PWR_FLAG').map(component => `${component.reference}: choose a real ${component.value} with the shown pin order and assign its footprint; none was guessed.`),
    ...(results.some(result => result.status === 'omitted') ? ['OMITTED DEVICES ARE NOT WIRED. Consult devices in export-report.json before treating this as the full simulated circuit.'] : []),
  ];
  const files: Record<string, string> = {
    'espemu.kicad_pro': '{}\n',
    'espemu.kicad_sch': renderSheet(root, true, sheets),
    'export-report.json': JSON.stringify({ formatVersion: 1, target: 'ESP32-WROOM-32', manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), devices: results, warnings, components }, null, 2) + '\n',
    'bom.csv': [['Reference', 'Value', 'Symbol', 'Footprint', 'Datasheet', 'Instance', 'Purpose'], ...components.filter(component => component.symbol !== 'power:PWR_FLAG').map(component => [component.reference, component.value, component.symbol, component.footprint, component.datasheet, component.instance, component.purpose])].map(row => row.map(field => `"${field.replace(/"/g, '""')}"`).join(',')).join('\n') + '\n',
    'LICENSE.kicad-symbols': libraryLicense,
    'LICENSE.ESPEmu': readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'),
    'README.txt': [
      'ESPEmu KiCad 7+ export', '',
      'Open espemu.kicad_pro, then espemu.kicad_sch. Sensor sheets are connected using explicit global nets.',
      'Symbols are embedded; generating/opening the schematic does not require downloading symbol libraries.',
      'Footprints refer to standard KiCad libraries. Missing footprints are deliberate, not fabricated.',
      'Run KiCad ERC, inspect the netlist and assign the remaining footprints before PCB work.',
      'The report records every included/omitted manifest instance, pin-to-net map, BOM purpose and source datasheet.',
      '', ...warnings, '',
      'Symbols: KiCad community, kicad-symbols 7.0.11, https://gitlab.com/kicad/libraries/kicad-symbols .',
      'Licensed CC-BY-SA-4.0 with the KiCad electronic-design exception; see LICENSE.kicad-symbols.',
      'A3144UA symbol geometry: original ESPEmu, MIT; see LICENSE.ESPEmu.',
    ].join('\n') + '\n',
  };
  for (const sheet of sheets) files[sheet.filename] = renderSheet(sheet, false, []);
  return Object.fromEntries(Object.entries(files).map(([name, content]) => [`kicad/${name}`, content]));
}
