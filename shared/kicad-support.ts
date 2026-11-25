import { isSensor, wiredPins, type CircuitDevice, type DeviceType } from './registry';

const comparator = (name: string) => `The ${name} module's sensor, comparator circuit and 3.3 V output are not identified.`;
const gas = (name: string) => `The ${name} module needs heater power, and its comparator circuit and 3.3 V output are not identified.`;
const moduleVariants = (name: string) => `${name} modules differ in connector order, supply and onboard circuit.`;
const industrial = 'This industrial sensor needs its own supply and an isolated interface. Do not connect it directly to an ESP32.';

// A simulated module name does not establish a real module's connector, onboard pull-ups, voltage or comparator circuit.
const unsupported: Partial<Record<DeviceType, string>> = {
  tmp105: 'The TMP105 chip-scale package has no qualified footprint.',
  bh1750: 'The BH1750 needs a power-on reset circuit on its DVI pin, and no qualified circuit exists.',
  ws2812b: 'WS2812 pixels need a 3.3 V to 5 V level shifter, 5 V power and a capacitor per pixel. No qualified circuit exists.',
  max7219: 'The MAX7219 module does not specify its LED matrix pinout, current resistor or 5 V level shifting.',
  max98357a: 'The MAX98357A module does not specify its package, gain and shutdown wiring or speaker load.',
  hd44780: 'The LCD backpack does not specify its PCF8574 variant, LCD pinout, contrast and backlight circuit or 5 V I2C level shifting.',
  ov2640: 'The camera needs an exact module connector and several supply rails. An ESP32-CAM camera cannot go on an ESP32-WROOM-32 board.',
  hc_sr501: moduleVariants('HC-SR501'),
  hc_sr505: moduleVariants('HC-SR505'),
  rcwl_0516: 'RCWL-0516 modules differ in connector order and power, and the antenna needs a qualified layout.',
  ttp223: 'The TTP223 module does not specify its chip variant, touch pad, sensitivity capacitor or output mode jumpers.',
  ss451a: 'The real SS451A responds to either magnet pole, so it does not match the latching sensor in the emulator.',
  sw_520d: 'The SW-520D package and contact arrangement are not qualified.',
  sw_420: comparator('SW-420'),
  ky_032: 'The KY-032 module optics, enable circuit, threshold circuit and 3.3 V output are not identified.',
  ky_026: comparator('KY-026'),
  fc_37: comparator('FC-37'),
  yl_69: comparator('YL-69'),
  mq_2: gas('MQ-2'),
  mq_135: gas('MQ-135'),
  ky_038: comparator('KY-038'),
  st188: comparator('ST188'),
  reed_59170: 'The Littelfuse 59170 part number, footprint and contact type are not qualified.',
  sn04_n: industrial,
  lj12a3: industrial,
  e18_d80nk: 'The E18-D80NK cable pinout, supply and output level shifting are not identified.',
};

export const KICAD_BOOT_PINS = [0, 2, 5, 12, 15];

/** Why KiCad export skips every device of this type, if it does. */
export function kicadTypeLimitation(type: DeviceType): string | undefined {
  return unsupported[type];
}

/** Why KiCad export skips this device, or undefined when it is exported. */
export function kicadOmission(device: CircuitDevice): string | undefined {
  if (unsupported[device.type]) return unsupported[device.type];
  if (device.type === 'a3144' && !device.activeLow) return 'The A3144 output is active-low. An active-high A3144 needs an inverter, which the export does not add.';
  if (!isSensor(device)) {
    const pins = wiredPins(device);
    const missing = pins.find(pin => pin === 37 || pin === 38);
    if (missing !== undefined) return `GPIO${missing} is not available on the ESP32-WROOM-32 module.`;
    const boot = pins.find(pin => KICAD_BOOT_PINS.includes(pin));
    // DevKit boards drive their onboard LED from GPIO2 to ground, which holds GPIO2 low at boot as download mode needs.
    const devkitLed = device.type === 'led' && device.pin === 2 && !device.activeLow;
    if (boot !== undefined && !devkitLed) return `GPIO${boot} is an ESP32 boot pin, and a device on it can stop the board from booting. Choose another pin to export this device.`;
    if ((device.type === 'button' || device.type === 'switch') && device.pin === 1) return 'A contact on GPIO1 can short the boot UART transmitter. Choose another pin to export this device.';
  }
  return undefined;
}
