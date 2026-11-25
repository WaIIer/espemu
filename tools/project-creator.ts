import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, realpathSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, join, basename, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { input, select, confirm, search } from '@inquirer/prompts';
import { z } from 'zod';
import { EMPTY_MANIFEST, DEMO_MANIFEST, ProjectManifestSchema, type ProjectManifest, type CircuitScenario } from '../shared/manifest.ts';
import { PERIPHERAL_REGISTRY, PIN_NUMBERS, controls, isSensor, wiredPins, type CircuitDevice, type DeviceType } from '../shared/registry.ts';
import { generateProjectArtifacts, devicePinsHeader, deviceMacroName } from './project-artifacts.ts';
import { loadProject } from '../server/project.ts';
import { ProjectCreatorConfigSchema } from '../shared/project-creator.ts';
import { openBrowser, serveCreator } from './web-creator.ts';

export const frameworkRoot = fileURLToPath(new URL('../', import.meta.url));
export type CreatorPlan = {
  directory: string;
  starter: 'empty' | 'blinky' | 'demo';
  manifest: ProjectManifest;
  blink?: { deviceId: string; intervalMs: number };
  mode: 'create' | 'build' | 'run';
  language?: 'c' | 'cpp';
  component?: { originalManifest: string | null; deviceId: string };
};
type ComponentContext = { directory: string; manifest: ProjectManifest; originalManifest: string | null };

export function checkDestination(directory: string, root = frameworkRoot): string {
  const destination = resolve(directory);
  let ancestor = destination;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const canonical = join(realpathSync(ancestor), relative(ancestor, destination));
  if (existsSync(destination)) {
    if (lstatSync(destination).isSymbolicLink()) throw new Error('Choose a real directory, not a symlink.');
    if (!lstatSync(destination).isDirectory()) throw new Error('The destination is not a directory.');
    if (readdirSync(destination).length) throw new Error('That folder is not empty. Choose a new or empty folder; existing project files will not be replaced.');
  }
  if (canonical === root || ['firmware', '.cache', 'tools', 'server', 'shared', 'frontend', 'tests', 'templates', 'qemu', 'docs'].some(folder => canonical === join(root, folder) || canonical.startsWith(join(root, folder) + '/'))) {
    throw new Error('Choose a separate project folder, not framework sources or caches.');
  }
  return destination;
}

export type Ask = (question: string) => Promise<string>;
export type CreatorPrompts = {
  text: (message: string, initial: string) => Promise<string>;
  confirm: (message: string, initial: boolean) => Promise<boolean>;
  select: (message: string, choices: { name: string; value: number }[], initial: number) => Promise<number>;
};
export async function interview(ask: Ask, output: (text: string) => void = console.log, suggestedDirectory?: string, prompts?: CreatorPrompts, existingProject?: ComponentContext): Promise<CreatorPlan | null> {
  async function validated<Value>(prompt: string, fallback: string, parse: (answer: string) => Value, hint = fallback): Promise<Value> {
    while (true) {
      const answer = (await (prompts ? prompts.text(prompt, fallback) : ask(`? ${prompt}${hint ? ` (${hint})` : ''} `))).trim() || fallback;
      try { return parse(answer); }
      catch (error) { output(error instanceof z.ZodError ? error.issues.map(issue => issue.message).join('; ') : error instanceof Error ? error.message : 'Invalid value.'); }
    }
  }
  const yes = (prompt: string, initial = false) => {
    if (prompts) return prompts.confirm(prompt, initial);
    return validated(prompt, initial ? 'yes' : 'no', answer => {
      if (/^(y|yes)$/i.test(answer)) return true;
      if (/^(n|no)$/i.test(answer)) return false;
      throw new Error('Enter yes or no.');
    }, initial ? 'Y/n' : 'y/N');
  };
  const number = (prompt: string, initial: number, minimum: number, maximum: number, integer = false) => validated(prompt, String(initial), answer => {
    const value = Number(answer);
    if (!answer || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) throw new Error(`Enter ${integer ? 'an integer' : 'a number'} from ${minimum} to ${maximum}.`);
    return value;
  });
  const choose = async <Value,>(prompt: string, options: { label: string; value: Value }[], initial = 1): Promise<Value> => {
    if (prompts) return options[(await prompts.select(prompt, options.map((option,index)=>({name:option.label,value:index+1})), initial)) - 1].value;
    output(options.map((option, index) => `  ${index + 1}. ${option.label}`).join('\n'));
    return validated(prompt, String(initial), answer => {
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1].value;
      const term = answer.toLowerCase(), key = (option: typeof options[number]) => typeof option.value === 'string' ? option.value.toLowerCase() : '';
      const exact = options.filter(option => option.label.toLowerCase() === term || key(option) === term);
      const matches = exact.length ? exact : options.filter(option => option.label.toLowerCase().includes(term));
      if (matches.length === 1) return matches[0].value;
      throw new Error(matches.length ? `${answer} matches ${matches.map(option => option.label).join(', ')}; type more of the name.` : `Enter a number from 1 to ${options.length} or part of a name.`);
    });
  };
  output(existingProject ? 'Add component' : 'ESPEmu');
  const directory = existingProject?.directory ?? await validated('Project directory', suggestedDirectory ?? 'my_project', answer => checkDestination(answer));
  const language = existingProject ? undefined : await choose('Language', [{label:'C',value:'c' as const},{label:'C++',value:'cpp' as const}]);
  const starter = existingProject ? 'empty' : await choose('Starter', [
    { label: 'Empty', value: 'empty' as const },
    { label: 'Blinky', value: 'blinky' as const },
    { label: 'All-device demo', value: 'demo' as const },
  ]);
  let manifest = structuredClone(existingProject?.manifest ?? (starter === 'demo' ? DEMO_MANIFEST : EMPTY_MANIFEST));
  let blink: CreatorPlan['blink'];
  const identity = (value: string) => z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/).refine(value => !['__proto__','constructor','prototype'].includes(value), 'Reserved id').parse(value);
  async function addDevice(type: DeviceType, suggestedId?: string): Promise<CircuitDevice> {
    const definition = PERIPHERAL_REGISTRY[type];
    if (manifest.devices.length >= 32) throw new Error('The circuit already has the maximum 32 devices.');
    if (definition.kind === 'i2c' && !manifest.buses.length && manifest.devices.some(device => !('bus' in device) && wiredPins(device).some(pin => pin === 21 || pin === 22))) throw new Error('I2C requires GPIO21/22, which are already wired in this circuit.');
    const freeAddresses = definition.kind === 'i2c' ? definition.addresses.filter(address => !manifest.devices.some(device => 'address' in device && device.address === address)) : [];
    if (definition.kind === 'i2c' && !freeAddresses.length) throw new Error(`All supported ${definition.label} addresses are occupied.`);
    output(`\n${definition.label}`);
    let suffix = manifest.devices.length + 1;
    let name = suggestedId ?? `${type}_${suffix}`;
    while (manifest.devices.some(device => device.id === name)) name = `${type}_${++suffix}`;
    const id = await validated('Instance id', name, value => {
      identity(value); if (manifest.devices.some(device => device.id === value)) throw new Error('That instance id is already used.'); return value;
    });
    const config: Record<string, unknown> = { id, type };
    const inputs: Record<string, number | boolean> = {};
    if (definition.kind === 'i2c') {
      config.bus = manifest.buses[0]?.id ?? 'i2c0';
      config.address = await validated('I2C address', `0x${freeAddresses[0].toString(16)}`, answer => {
        const address = Number(answer);
        if (!(definition.addresses as readonly number[]).includes(address)) throw new Error(`Supported addresses: ${definition.addresses.join(', ')}.`);
        if (manifest.devices.some(device => 'address' in device && device.address === address)) throw new Error('That I2C address is already occupied.');
        return address;
      });
      if (type === 'hd44780') config.size = await choose('LCD size', [{ label: '16x2', value: '16x2' }, { label: '20x4', value: '20x4' }]);
      for (const [name, control] of Object.entries(controls(type))) inputs[name] = await number(`Initial ${control.label} (${control.unit})`, control.initial, control.minimum, control.maximum);
      inputs.connected = true; inputs.invalid = false;
    } else {
      const outputDevice = type === 'led' || type === 'rgb' || type === 'ws2812b' || type === 'max7219' || type === 'max98357a';
      const pin = (prompt: string, preferred: number, excluded: number[] = []) => {
        const reasons = new Map<number,string>();
        for (let value = 0; value < 40; value++) {
          if (!PIN_NUMBERS.includes(value)) reasons.set(value, value >= 6 && value <= 11 ? 'reserved for flash' : 'unavailable in this framework');
          else if (outputDevice && value >= 34) reasons.set(value, 'input-only; cannot drive an LED');
          else if (excluded.includes(value)) reasons.set(value, 'already chosen for another device signal');
          else if (manifest.buses.length && (value === 21 || value === 22)) reasons.set(value, 'reserved for I2C');
          const owner = manifest.devices.find(device => !('bus' in device) && device.type !== 'probe' && wiredPins(device).includes(value));
          if (!reasons.has(value) && owner && type !== 'probe') reasons.set(value, `already wired to ${owner.id}`);
        }
        const available = PIN_NUMBERS.filter(value => !reasons.has(value));
        const initial = [preferred,16,17,18,19,23,25,26,27,32,33,...available].find(value => available.includes(value));
        if (initial === undefined) throw new Error('No eligible unused pins remain for this device.');
        const guide = `Available ${outputDevice ? 'output' : 'GPIO'} pins: ${available.join(', ')}.\nUnavailable pins: ${Array.from(reasons,([value,reason])=>`GPIO${value}: ${reason}`).join('; ')}.\nGPIO${initial} is a free suggestion, not required wiring. Type a pin number or GPIO<number>; Enter accepts the suggestion, ? shows this guide.\nReal-board caution: GPIO0/2/5/12/15 are boot-strapping pins, GPIO1/3 commonly serve UART0, and some modules use GPIO16/17 for PSRAM. These board-specific behaviors are not simulated.`;
        return validated(prompt, String(initial), answer => {
          if (/^(\?|help)$/i.test(answer)) throw new Error(guide);
          const value = Number(answer.replace(/^gpio\s*/i,''));
          if (!available.includes(value)) throw new Error(`GPIO${answer}: ${reasons.get(value) ?? 'invalid pin'}. Press Enter for GPIO${initial} or ? for help.`);
          return value;
        });
      };
      if (type === 'ov2640') {
        // Board wiring is fixed on ESP32-CAM modules; custom wiring goes through DEVICE='{"type":"ov2640","signals":{...}}'.
        config.signals = PERIPHERAL_REGISTRY.ov2640.config.parse(config).signals;
        output(`Using AI-Thinker ESP32-CAM wiring (${Object.entries(config.signals as Record<string,number>).filter(([,value])=>value>=0).map(([signal,value])=>`${signal.toUpperCase()} ${value}`).join(', ')}).`);
      } else if (type === 'max98357a') {
        const bclk = await pin('BCLK GPIO', 26), lrclk = await pin('LRCLK GPIO', 25, [bclk]);
        config.bclk = bclk; config.lrclk = lrclk; config.din = await pin('DIN GPIO', 27, [bclk, lrclk]);
      } else if (type === 'max7219') {
        const din = await pin('DIN GPIO', 23), clk = await pin('CLK GPIO', 18, [din]);
        config.din = din; config.clk = clk; config.load = await pin('LOAD GPIO', 5, [din,clk]);
        config.length = await number('8x8 module count', 1, 1, 16, true);
        config.color = await choose('Matrix LED color', ['red','green','blue','amber','white'].map(value => ({ label: value, value })));
      } else if (type === 'rgb') {
        const red = await pin('Red GPIO', 16), green = await pin('Green GPIO', 17, [red]);
        const blue = await pin('Blue GPIO', 18, [red,green]); config.pins = [red, green, blue];
      } else config.pin = await pin('GPIO pin', type === 'led' || type === 'probe' ? 2 : type==='ws2812b'?18:27);
      if(type==='ws2812b'){
        config.length=await number('LED count',1,1,1024,true);config.activeLow=false;
      }else if (type === 'max7219') config.activeLow = false;
      else if (type !== 'ov2640' && type !== 'max98357a') {
        const defaults = definition.config.parse(config);
        config.activeLow = await yes('Active low?', 'activeLow' in defaults && defaults.activeLow);
        if ((config.pin as number) >= 34 && 'pullUp' in definition.config.shape && (config.activeLow || ('drive' in definition && definition.drive === 'open-collector'))) config.pullUp = await yes('Pull-up resistor on the module or board? (GPIO34-39 have no internal pulls)', true);
      }
      if (type === 'led') config.color = await choose('LED color', ['red','green','blue','amber','white'].map(value => ({ label: value, value })));
    }
    const device = definition.config.parse(config) as CircuitDevice;
    const buses = definition.kind === 'i2c' && !manifest.buses.length ? structuredClone(DEMO_MANIFEST.buses) : manifest.buses;
    const next = ProjectManifestSchema.parse({ ...manifest, buses, devices: [...manifest.devices, device], inputs: { ...manifest.inputs, ...(definition.kind === 'i2c' ? { [id]: inputs } : {}) } });
    devicePinsHeader(next); manifest = next;
    return device;
  }
  if (existingProject) {
    const type = await choose('Peripheral type', Object.entries(PERIPHERAL_REGISTRY).map(([value,definition])=>({label:definition.label,value:value as DeviceType})));
    const device = await addDevice(type);
    if (!await yes('Add component?',true)) { output('Cancelled. No files changed.'); return null; }
    return {directory,manifest,starter:'empty',mode:'create',component:{originalManifest:existingProject.originalManifest,deviceId:device.id}};
  }
  if (starter === 'blinky') {
    const led = await addDevice('led', 'status_led');
    blink = { deviceId: led.id, intervalMs: await number('On/off interval (milliseconds)', 500, 1, 60000, true) };
  }
  while (true) {
    if (!await yes('Add a device?')) break;
    const type = await choose('Peripheral type', Object.entries(PERIPHERAL_REGISTRY).map(([value, definition]) => ({ label: definition.label, value: value as DeviceType })));
    try { await addDevice(type); }
    catch (error) { output(error instanceof Error ? error.message : 'Invalid circuit device'); }
  }
  const targets = manifest.devices.flatMap(device => Object.entries(controls(device.type)).map(([channel, control]) => ({ deviceId: device.id, channel, control })));
  if (targets.length) {
    while (await yes('Add an input scenario?')) {
      const target = await choose('Scenario channel', targets.map(target => ({ label: `${target.deviceId}.${target.channel} (${target.control.unit})`, value: target })));
      const kind = await choose('Scenario mode', ['ramp','sine','noise','playback'].map(value => ({ label: value, value: value as CircuitScenario['kind'] })));
      const offset = await number('Offset', target.control.initial, target.control.minimum, target.control.maximum);
      const amplitude = await number('Amplitude', 1, 0, target.control.maximum - target.control.minimum);
      const periodMs = await number('Period (milliseconds)', 10000, 100, 3600000, true);
      const seed = await number('Noise seed', 42, 0, 4294967295, true);
      const frames = kind === 'playback' ? await validated('JSON frame file ({timeMs,value} array)', '', filename => {
        const value = JSON.parse(readFileSync(resolve(filename), 'utf8'));
        return z.array(z.object({ timeMs: z.number().nonnegative(), value: z.number().finite() }).strict()).min(1).max(10000).parse(value);
      }) : [];
      const scenario = { deviceId: target.deviceId, channel: target.channel, kind, offset, amplitude, periodMs, seed, frames };
      manifest = ProjectManifestSchema.parse({ ...manifest, scenarios: manifest.scenarios.filter(value => value.deviceId !== target.deviceId || value.channel !== target.channel).concat(scenario) });
    }
  }
  const mode = await choose('After generating files', [
    { label: 'Create only', value: 'create' as const },
    { label: 'Create and build', value: 'build' as const },
    { label: 'Create, build and run', value: 'run' as const },
  ]);
  output(`\nProject: ${directory}\nStarter: ${starter}\nCircuit: ${manifest.devices.length} peripheral(s)\n${manifest.devices.map(device => `  ${device.id}: ${device.type} ${'address' in device ? `I2C 0x${device.address.toString(16)}` : `GPIO ${wiredPins(device).join('/')}`}`).join('\n')}\nMode: ${mode}`);
  if (!await yes('Create project?', true)) { output('Cancelled. No project files were generated.'); return null; }
  return { directory, starter, manifest, blink, mode, language };
}

function manifestText(directory: string): string | null {
  const filename=join(directory,'espemu.json'),info=lstatSync(filename,{throwIfNoEntry:false});
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('espemu.json must be a regular file, not a symlink.');
  if (info.size>1024*1024) throw new Error('Manifest exceeds 1MiB.');
  return readFileSync(filename,'utf8');
}

export async function interviewComponent(ask: Ask, output: (text: string) => void = console.log, projectDirectory = process.cwd(), prompts?: CreatorPrompts): Promise<CreatorPlan | null> {
  const directory=realpathSync(resolve(projectDirectory));
  if (!existsSync(join(directory,'CMakeLists.txt'))) throw new Error(`Not an ESP-IDF project: ${directory}`);
  const originalManifest=manifestText(directory);
  const manifest=loadProject(frameworkRoot,{ESPEMU_PROJECT:directory}).manifest;
  return interview(ask,output,directory,prompts,{directory,manifest,originalManifest});
}

const DeviceSpecSchema = z.object({ type: z.string(), inputs: z.record(z.union([z.number().finite(), z.boolean()])).optional() }).passthrough();
/** Plans one device from `TYPE` or a JSON device object; omitted fields use the wizard's free-pin/address defaults. */
export async function componentFromSpec(spec: string, projectDirectory = process.cwd()): Promise<CreatorPlan> {
  const text = spec.trim();
  const { inputs, ...fields } = DeviceSpecSchema.parse(text.startsWith('{') ? JSON.parse(text) : { type: text });
  if (!Object.hasOwn(PERIPHERAL_REGISTRY, fields.type)) throw new Error(`Unknown device type ${fields.type}. Supported: ${Object.keys(PERIPHERAL_REGISTRY).join(', ')}.`);
  const types = Object.keys(PERIPHERAL_REGISTRY), type = fields.type as DeviceType;
  const value = (key: string) => (fields as Record<string, unknown>)[key];
  const pins = Array.isArray(value('pins')) ? value('pins') as unknown[] : [];
  const textFields: Record<string, unknown> = { 'Instance id': value('id'), 'I2C address': value('address'), 'GPIO pin': value('pin'), 'Red GPIO': pins[0], 'Green GPIO': pins[1], 'Blue GPIO': pins[2],
    'DIN GPIO': value('din'), 'CLK GPIO': value('clk'), 'BCLK GPIO': value('bclk'), 'LRCLK GPIO': value('lrclk'), 'LOAD GPIO': value('load'), 'LED count': value('length'), '8x8 module count': value('length'),
    ...Object.fromEntries(Object.entries(controls(type)).map(([channel, control]) => [`Initial ${control.label} (${control.unit})`, inputs?.[channel]])) };
  const colors = ['red', 'green', 'blue', 'amber', 'white'];
  // Each answer comes from the spec, so a repeated question means the wizard rejected it.
  const asked = new Set<string>();
  let rejection = '';
  const once = (message: string) => { if (asked.has(message)) throw new Error(rejection || `Invalid value for ${message}.`); asked.add(message); };
  const plan = await interviewComponent(async () => { throw new Error('Unexpected question'); }, text => { rejection = text; }, projectDirectory, {
    text: async (message, initial) => { once(message); const answer = textFields[message]; return answer === undefined ? initial : String(answer); },
    confirm: async (message, initial) => { once(message); const answer = message === 'Active low?' ? value('activeLow') : message.startsWith('Pull-up') ? value('pullUp') : undefined; return typeof answer === 'boolean' ? answer : initial; },
    select: async (message, _choices, initial) => { once(message); return message === 'Peripheral type' ? types.indexOf(type) + 1 : message === 'LCD size' && value('size') === '20x4' ? 2 : message.endsWith('LED color') && typeof value('color') === 'string' && colors.includes(value('color') as string) ? colors.indexOf(value('color') as string) + 1 : initial; },
  });
  if (!plan?.component) throw new Error('No component was planned.');
  const added = plan.manifest.devices.find(device => device.id === plan.component!.deviceId)!;
  // Partial camera wiring overrides only the named signals of the board default.
  const signals = value('signals');
  const device = { ...added, ...fields, ...('signals' in added && signals && typeof signals === 'object' ? { signals: { ...added.signals, ...signals } } : {}) } as CircuitDevice;
  const manifestInputs = { ...plan.manifest.inputs };
  delete manifestInputs[added.id];
  if (isSensor(device)) manifestInputs[device.id] = { ...plan.manifest.inputs[added.id], ...inputs };
  else if (inputs) throw new Error(`${device.type} has no physical-input channels.`);
  const manifest = ProjectManifestSchema.parse({ ...plan.manifest, devices: plan.manifest.devices.map(entry => entry.id === added.id ? device : entry), inputs: manifestInputs });
  devicePinsHeader(manifest);
  return { ...plan, manifest, component: { ...plan.component, deviceId: device.id } };
}

export function addComponent(plan: CreatorPlan, root = frameworkRoot) {
  if (!plan.component) throw new Error('Expected a one-component plan.');
  const directory=realpathSync(plan.directory),filename=join(directory,'espemu.json');
  if (!existsSync(join(directory,'CMakeLists.txt'))) throw new Error(`Not an ESP-IDF project: ${directory}`);
  const manifest=ProjectManifestSchema.parse(plan.manifest);devicePinsHeader(manifest);
  const unchanged=()=>{if(manifestText(directory)!==plan.component!.originalManifest)throw new Error('The circuit changed during setup. No files changed; run make add_component again.');};
  unchanged();
  if (lstatSync(join(directory,'.espemu-generated.json'),{throwIfNoEntry:false})?.isSymbolicLink()) throw new Error('Generated-file record is a symlink; no files changed.');
  const temporary=join(directory,`.espemu-${randomUUID()}.tmp`);
  try {
    const mode=lstatSync(filename,{throwIfNoEntry:false})?.mode;
    writeFileSync(temporary,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:mode===undefined?0o644:mode&0o777});
    unchanged();renameSync(temporary,filename);
  } finally { rmSync(temporary,{force:true}); }
  return generateProjectArtifacts(directory,root);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: bash tools/create-project.sh [NEW_OR_EMPTY_DIRECTORY]\n       bash tools/create-project.sh DIRECTORY --config FILE|--config-json JSON [--init-only|--no-run|--run]\n       bash tools/create-project.sh [DIRECTORY] --web [--init-only|--no-run|--run]\n       bash tools/create-project.sh --add-component [PROJECT_DIRECTORY] [--device TYPE|JSON]'); return;
  }
  let plan: CreatorPlan | null;
  const web = args.indexOf('--web');
  if (web >= 0 && web <= 1 && !(web === 1 && args[0].startsWith('-'))) {
    const rest = args.filter((_, index) => index !== web), directoryArgument = web === 1 ? args[0] : undefined;
    const modes = rest.slice(directoryArgument === undefined ? 0 : 1);
    if (modes.length > 1 || (modes[0] && !['--init-only', '--no-run', '--run'].includes(modes[0]))) throw new Error('Expected [DIRECTORY] --web [--init-only|--no-run|--run].');
    const mode = modes[0] === '--run' ? 'run' : modes[0] === '--no-run' ? 'build' : 'create';
    // A given directory is checked up front and prefilled; otherwise the page proposes one in the current folder.
    const proposed = directoryArgument === undefined ? undefined : checkDestination(directoryArgument);
    let name = 'my_project';
    for (let suffix = 2; !proposed && existsSync(join(process.cwd(), name)); suffix++) name = `my_project_${suffix}`;
    const initial = proposed ? { location: dirname(proposed), name: basename(proposed) } : { location: process.cwd(), name };
    const session = await serveCreator(frameworkRoot, initial, mode, directory => checkDestination(directory), (config, directory) => {
      createProject({ ...config, directory, mode });
    }, creatorPort());
    let created = false, cancelled = false;
    const cancel = () => {
      cancelled = true;
      console.log(created ? '\nCancelled after the project was created; no build was started.' : '\nCancelled. No files changed.');
      void session.close().finally(() => process.exit(130));
    };
    process.once('SIGINT', cancel);
    console.log(`Design the project in the web project creator:\n  ${session.url}\nFiles are created when you press Create project in the page. Ctrl+C cancels.`);
    openBrowser(session.url);
    const { config, directory } = await session.done;
    created = true;
    await session.close();
    // A Ctrl+C queued during creation is delivered here, before any build starts.
    await new Promise(resolve => setImmediate(resolve));
    process.removeListener('SIGINT', cancel);
    if (!cancelled) finishProject(directory, { ...config, directory, mode });
    return;
  }
  if (args[1] === '--config' || args[1] === '--config-json') {
    if (args.length < 3 || args.length > 4 || (args[3] && !['--init-only', '--no-run', '--run'].includes(args[3]))) throw new Error('Expected DIRECTORY --config FILE|--config-json JSON [--init-only|--no-run|--run].');
    const text = args[1] === '--config-json' ? args[2] : readFileSync(args[2] === '-' ? 0 : resolve(args[2]), 'utf8');
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Creator configuration exceeds 1MiB.');
    const config = ProjectCreatorConfigSchema.parse(JSON.parse(text));
    plan = { ...config, directory: args[0], mode: args[3] === '--run' ? 'run' : args[3] === '--no-run' ? 'build' : 'create' };
  } else if (args[0] === '--add-component' && args.includes('--device')) {
    const at = args.indexOf('--device'), spec = args[at + 1], directories = args.slice(1).filter((_, index) => index + 1 !== at && index + 1 !== at + 1);
    if (spec === undefined || directories.length > 1) throw new Error('Expected --add-component [PROJECT_DIRECTORY] --device TYPE|JSON.');
    plan = await componentFromSpec(spec, directories[0]);
  } else {
    const componentOnly=args[0]==='--add-component',directories=componentOnly?args.slice(1):args;
    if (directories.length > 1) throw new Error('Provide at most one project directory.');
    const collect=(ask:Ask,prompts?:CreatorPrompts)=>componentOnly?interviewComponent(ask,console.log,directories[0],prompts):interview(ask,console.log,directories[0],prompts);
    if (stdin.isTTY && stdout.isTTY) {
      try {
        plan = await collect(async () => '', {
          text: (message, initial) => input({ message, default: initial || undefined }),
          confirm: (message, initial) => confirm({ message, default: initial }),
          select: (message, choices, initial) => choices.length > 8
            ? search({ message: `${message} (type to filter)`, source: term => choices.filter(choice => !term || choice.name.toLowerCase().includes(term.toLowerCase())) })
            : select({ message, choices, default: initial }),
        });
      } catch (error) {
        if (error instanceof Error && ['ExitPromptError','AbortPromptError'].includes(error.name)) { process.exitCode=130; return; }
        throw error;
      }
    } else {
      const terminal = createInterface({ input: stdin, output: stdout, terminal: false });
      // Piped answers can arrive before a question is asked; queue them instead of using question().
      const lines: string[] = [], waiting: ((line: string | null) => void)[] = [];
      let ended = false;
      terminal.on('line', line => { const next = waiting.shift(); if (next) next(line); else lines.push(line); });
      terminal.on('close', () => { ended = true; for (const next of waiting.splice(0)) next(null); });
      const abort = () => { process.exitCode = 130; terminal.close(); };
      process.once('SIGINT', abort);
      try {
        plan = await collect(async question => {
          stdout.write(question);
          const line = lines.length ? lines.shift()! : ended ? null : await new Promise<string | null>(done => waiting.push(done));
          if (line === null) throw new Error(process.exitCode === 130 ? 'Cancelled. No files changed.' : 'Input ended before every question was answered. No files changed.');
          stdout.write(`${line}\n`);
          return line;
        });
      }
      finally { terminal.close(); process.removeListener('SIGINT', abort); }
    }
  }
  if (!plan) return;
  if (plan.component) {
    const result=addComponent(plan);
    const added=plan.manifest.devices.find(device=>device.id===plan.component!.deviceId)!;
    const wiring='address' in added?`I2C 0x${added.address.toString(16)}`:wiredPins(added).map(pin=>`GPIO${pin}`).join('/');
    console.log(`Added ${added.id} (${PERIPHERAL_REGISTRY[added.type].label}, ${wiring}); macros ${deviceMacroName(added.id)}_* are in main/device_pins.h and usage is in ESPEMU-DEVICES.md. Run make run when ready.`);
    if (result.preserved.length) console.log(`Edited generated files preserved: ${result.preserved.join(', ')}`);
    return;
  }
  finishProject(createProject(plan), plan);
}

function creatorPort() {
  const text = process.env.ESPEMU_CREATOR_PORT ?? '0', port = Number(text);
  if (!/^\d+$/.test(text) || port > 65535) throw new Error(`ESPEMU_CREATOR_PORT must be a port number from 0 to 65535, not ${text}.`);
  return port;
}

function finishProject(directory: string, plan: CreatorPlan) {
  console.log(`\nCreated ${directory}\nFirmware: ${join(directory, `main/main.${plan.language==='cpp'?'cpp':'c'}`)}\nCircuit: ${join(directory, 'espemu.json')}`);
  if (plan.mode !== 'create') {
    execFileSync('bash', [join(frameworkRoot, 'tools/demo.sh'), directory, ...(plan.mode === 'build' ? ['--build-only'] : [])], { stdio: 'inherit', env: process.env });
  } else console.log('From the project directory: make build or make run');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    console.error(error instanceof z.ZodError ? `Invalid configuration:\n${error.issues.map(issue => `  ${issue.path.join('.') || 'value'}: ${issue.message}`).join('\n')}` : error instanceof Error ? error.message : String(error));
    process.exitCode = process.exitCode === 130 ? 130 : 1;
  });
}

export function blinkySource(pin: number, activeLow: boolean, intervalMs: number, language: 'c' | 'cpp' = 'c', deviceId = 'led'): string {
  const output = PERIPHERAL_REGISTRY.led.config.parse({ id: 'blink', type: 'led', pin, activeLow });
  z.number().int().min(1).max(60000).parse(intervalMs);
  const name = deviceMacroName(deviceId);
  return `#include "device_pins.h"
#include "driver/gpio.h"
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define LED_PIN ${name}_PIN
#define BLINK_INTERVAL_MS ${intervalMs}

${language === 'cpp' ? 'extern "C" ' : ''}void app_main(void)
{
  gpio_config_t config${language === 'cpp' ? '{}' : ' = {0}'};
  config.pin_bit_mask = 1ULL << LED_PIN;
  config.mode = GPIO_MODE_OUTPUT;
    ESP_ERROR_CHECK(gpio_config(&config));
    ESP_ERROR_CHECK(gpio_set_level(LED_PIN, ${name}_INACTIVE_LEVEL));
    while (true) {
        ESP_ERROR_CHECK(gpio_set_level(LED_PIN, ${name}_ACTIVE_LEVEL));
        vTaskDelay(pdMS_TO_TICKS(BLINK_INTERVAL_MS));
        ESP_ERROR_CHECK(gpio_set_level(LED_PIN, ${name}_INACTIVE_LEVEL));
        vTaskDelay(pdMS_TO_TICKS(BLINK_INTERVAL_MS));
    }
}
`;
}

export function createProject(plan: CreatorPlan, root = frameworkRoot): string {
  const manifest = ProjectManifestSchema.parse(plan.manifest);
  devicePinsHeader(manifest);
  const language = plan.language ?? 'c';
  const destination = checkDestination(plan.directory, root);
  let source: string | null = null;
  if (plan.starter === 'blinky') {
    const device = manifest.devices.find(device => device.id === plan.blink?.deviceId);
    if (!device || device.type !== 'led') throw new Error('The blinky starter needs a declared LED.');
    source = blinkySource(device.pin, device.activeLow, plan.blink!.intervalMs, language, device.id);
  }
  execFileSync('bash', [join(root, 'tools/setup-project.sh'), destination, '--template', plan.starter === 'demo' ? 'demo' : 'empty', '--init-only'], { encoding: 'utf8', cwd: root });
  const initialManifest = readFileSync(join(root, plan.starter === 'demo' ? 'firmware/espemu.json' : 'templates/empty/espemu.json'), 'utf8');
  if (readFileSync(join(destination, 'espemu.json'), 'utf8') !== initialManifest) throw new Error('The generated manifest changed before completion; it was not overwritten.');
  if (source) {
    if (readFileSync(join(destination, 'main/main.c'), 'utf8') !== readFileSync(join(root, 'templates/empty/main/main.c'), 'utf8')) throw new Error('Application source changed during setup; it was not overwritten.');
    if (language === 'cpp') rmSync(join(destination, 'main/main.c'));
    writeFileSync(join(destination, `main/main.${language === 'cpp' ? 'cpp' : 'c'}`), source);
    writeFileSync(join(destination, 'main/CMakeLists.txt'), `idf_component_register(SRCS "main.${language === 'cpp' ? 'cpp' : 'c'}" INCLUDE_DIRS "." REQUIRES esp_driver_gpio)\n`);
  } else if (language === 'cpp') {
    const initialSource = readFileSync(join(destination,'main/main.c'),'utf8');
    if (plan.starter === 'demo') {
      if (!initialSource.includes('void app_main(void)')) throw new Error('Cannot adapt the demo entry point safely.');
      mkdirSync(join(destination,'components/espemu_demo'),{recursive:true});
      writeFileSync(join(destination,'components/espemu_demo/demo.c'),initialSource.replace('void app_main(void)','void espemu_demo_main(void)'));
      writeFileSync(join(destination,'components/espemu_demo/CMakeLists.txt'),readFileSync(join(destination,'main/CMakeLists.txt'),'utf8').replace('"main.c"','"demo.c"').replace('INCLUDE_DIRS "."','INCLUDE_DIRS "." "../../main"').replace('REQUIRES ','REQUIRES espemu_devices '));
      writeFileSync(join(destination,'main/main.cpp'),'#include "device_pins.h"\nextern "C" void espemu_demo_main(void);\nextern "C" void app_main(void)\n{\n    espemu_demo_main();\n}\n');
      writeFileSync(join(destination,'main/CMakeLists.txt'),'idf_component_register(SRCS "main.cpp" INCLUDE_DIRS "." REQUIRES espemu_demo driver)\n');
    } else {
      writeFileSync(join(destination,'main/main.cpp'),'#include "device_pins.h"\nextern "C" void app_main(void)\n{\n}\n');
      writeFileSync(join(destination,'main/CMakeLists.txt'),'idf_component_register(SRCS "main.cpp" INCLUDE_DIRS ".")\n');
    }
    rmSync(join(destination,'main/main.c'));
  }
  writeFileSync(join(destination, 'espemu.json'), JSON.stringify(manifest, null, 2) + '\n');
  const name = basename(destination).replace(/[^A-Za-z0-9_]/g, '_');
  const cmake = readFileSync(join(destination, 'CMakeLists.txt'), 'utf8');
  writeFileSync(join(destination, 'CMakeLists.txt'), cmake.replace('project(espemu)', `project(${name})`));
  generateProjectArtifacts(destination,root);
  return destination;
}
