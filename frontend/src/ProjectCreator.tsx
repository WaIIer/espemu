import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Copy, Cpu, Download, Pencil, Plus, Trash2, Undo2 } from 'lucide-react';
import { NewProjectCard, useCreatorSession } from './CreatorSession';
import { z } from 'zod';
import { DEMO_MANIFEST, EMPTY_MANIFEST, ProjectManifestSchema, type ProjectManifest } from '../../shared/manifest';
import { ProjectCreatorConfigSchema, type ProjectCreatorConfig } from '../../shared/project-creator';
import { ESP32_CAM_SIGNALS, PERIPHERAL_GROUPS, PERIPHERAL_REGISTRY, PIN_NUMBERS, controls, isCamera, isPeripheralInput, isSensor, peripheralGroup, wiredPins, type DeviceType } from '../../shared/registry';
import { ThemeControls, useTheme } from './ThemeControls';
import './creator.css';

const json = (value: unknown) => JSON.stringify(value, null, 2);
const failureText = (error: unknown) => error instanceof z.ZodError
  ? error.issues.slice(0,3).map(issue => `${issue.path.join('.') || 'Configuration'}: ${issue.message}`).join('; ')
  : error instanceof Error ? error.message : 'Invalid configuration';
const draftKey = 'espemu.creator.draft';
const maxDraftLength = 1024 * 1024;
const DraftSchema = z.object({ v: z.literal(1), starter: z.enum(['empty','blinky','demo']), language: z.enum(['c','cpp']),
  manifestText: z.string().max(maxDraftLength), lastValid: ProjectManifestSchema, blinkId: z.string(), interval: z.string() }).strict();
type CreatorDraft = z.infer<typeof DraftSchema>;
const emptyDraft: CreatorDraft = { v: 1, starter: 'empty', language: 'c', manifestText: json(EMPTY_MANIFEST), lastValid: EMPTY_MANIFEST, blinkId: 'status_led', interval: '500' };
function loadDraft() {
  try { const saved = localStorage.getItem(draftKey);return { draft: saved ? DraftSchema.parse(JSON.parse(saved)) : emptyDraft, error: '' }; }
  catch { return { draft: emptyDraft, error: 'Saved draft could not be restored. Your current edits remain available to export.' }; }
}

function DeviceForm({ manifest, editing, save, cancel }: { manifest: ProjectManifest; editing?: ProjectManifest['devices'][number]; save: (value: ProjectManifest, id: string) => void; cancel: () => void }) {
  const [type, setType] = useState<DeviceType>(editing?.type??'led');
  const [error, setError] = useState<string | null>(null);
  const definition = PERIPHERAL_REGISTRY[type];
  const sensor = definition.kind === 'i2c', camera = definition.kind === 'camera';
  const shape = definition.config.shape;
  const defaultActiveLow = 'activeLow' in shape ? shape.activeLow.parse(undefined) : false;
  const others=manifest.devices.filter(device=>device.id!==editing?.id);
  const availablePins = PIN_NUMBERS.filter(pin =>
    (!(type === 'led' || type === 'rgb' || type === 'ws2812b' || type === 'max7219' || type === 'max98357a') || pin < 34) &&
    (!manifest.buses.length || (pin !== 21 && pin !== 22)) &&
    (type === 'probe' || !others.some(device => !isSensor(device) && device.type !== 'probe' && wiredPins(device).includes(pin))));
  const availableAddresses = sensor ? definition.addresses.filter(address => !others.some(device => isSensor(device) && device.address === address)) : [];
  let suffix = 1;
  while (manifest.devices.some(device => device.id === `${type}_${suffix}`)) suffix++;
  const suggestedId = `${type}_${suffix}`;
  const suggestedPins = [2, 16, 17, 18, 19, 23, 25, 26, 27, ...availablePins].filter((pin, index, pins) => availablePins.includes(pin) && pins.indexOf(pin) === index);
  const signals = type === 'max98357a' ? ['bclk', 'lrclk', 'din'] : type === 'max7219' ? ['din', 'clk', 'load'] : type === 'rgb' ? ['red', 'green', 'blue'] : ['pin'];
  const unavailable = others.length >= 32 || (camera ? others.some(isCamera) : sensor ? !availableAddresses.length : availablePins.length < signals.length);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const id = String(form.get('id'));
    const config: Record<string, unknown> = { id, type };
    const label = String(form.get('label')).trim();
    if (label) config.label = label;
    if (sensor) {
      config.bus = manifest.buses[0]?.id ?? 'i2c0';
      config.address = Number(form.get('address'));
      if (type === 'hd44780') config.size = form.get('size');
    } else if (camera) {
      // ESP32-CAM modules have fixed board wiring; edit espemu.json for a custom DVP harness.
      config.signals = editing && isCamera(editing) ? editing.signals : ESP32_CAM_SIGNALS;
    } else {
      if (type === 'max7219' || type === 'max98357a') for (const signal of signals) config[signal] = Number(form.get(signal));
      else if (type === 'rgb') config.pins = signals.map(channel => Number(form.get(channel)));
      else config.pin = Number(form.get('pin'));
      if (type !== 'max98357a') config.activeLow = form.has('activeLow');
      if (type === 'led' || type === 'max7219') config.color = form.get('color');
      if (type === 'ws2812b' || type === 'max7219') config.length = Number(form.get('length'));
    }
    try {
      const inputs = sensor ? {
        [id]: { connected: true, invalid: false, ...manifest.inputs[editing?.id??''], ...Object.fromEntries(Object.keys(controls(type)).map(name => [name, Number(form.get(name))])) },
      } : {};
      const previousPin=editing&&isPeripheralInput(editing)?editing.pin:undefined;
      const next = ProjectManifestSchema.parse({
        ...manifest,
        buses: sensor && !manifest.buses.length ? DEMO_MANIFEST.buses : manifest.buses,
        devices: editing?manifest.devices.map(device=>device.id===editing.id?config:device):[...manifest.devices, config],
        inputs: { ...Object.fromEntries(Object.entries(manifest.inputs).filter(([key])=>key!==editing?.id)), ...inputs },
        scenarios: manifest.scenarios.map(scenario=>scenario.deviceId===editing?.id?{...scenario,deviceId:id}:scenario),
        gpioInputs: manifest.gpioInputs.map(input=>input.pin===previousPin?{...input,pin:config.pin}:input),
      });
      save(next,id);
      setError(null);
    } catch (failure) { setError(failureText(failure)); }
  }

  return <section className="creator-card" aria-label={editing?`Edit ${editing.id}`:'Add peripheral'}>
    <h2>{editing?<Pencil size={17}/>:<Plus size={17} />}{editing?'Edit peripheral':'Add peripheral'}</h2>
    <label>Peripheral type<select value={type} disabled={!!editing} onChange={event => { setType(event.target.value as DeviceType); setError(null); }}>
      {PERIPHERAL_GROUPS.map(group => <optgroup key={group} label={group}>{(Object.keys(PERIPHERAL_REGISTRY) as DeviceType[]).filter(value => peripheralGroup(value) === group).map(value => <option key={value} value={value}>{PERIPHERAL_REGISTRY[value].label}</option>)}</optgroup>)}
    </select></label>
    <form key={`${type}:${json(manifest.devices)}:${json(manifest.buses)}`} onSubmit={submit}>
      <div className="creator-fields">
        <label>Instance id<input name="id" defaultValue={editing?.id??suggestedId} required pattern={String.raw`[a-zA-Z0-9_\-]{1,50}`} maxLength={50} /></label>
        <label>Label (optional)<input name="label" defaultValue={editing?.label??''} maxLength={40} /></label>
        {sensor && <label>I2C address<select name="address" required defaultValue={editing&&isSensor(editing)?editing.address:availableAddresses[0]}>
          {availableAddresses.map(address => <option key={address} value={address}>0x{address.toString(16)}</option>)}
        </select></label>}
        {type === 'hd44780' && <label>LCD size<select name="size" defaultValue={editing && 'size' in editing ? editing.size : '16x2'}><option>16x2</option><option>20x4</option></select></label>}
        {sensor ? null : camera ? null : <>
          {signals.map((name, index) => <label key={name}>{type === 'max7219' || type === 'max98357a' ? `${name.toUpperCase()} GPIO` : type === 'rgb' ? `${name} GPIO` : 'GPIO pin'}
            <select name={name} required defaultValue={editing&&!isSensor(editing)?wiredPins(editing)[index]:suggestedPins[index]}>
              {availablePins.map(pin => <option key={pin} value={pin}>GPIO{pin}</option>)}
            </select>
          </label>)}
          {type !== 'ws2812b' && type !== 'max7219' && type !== 'max98357a' && <label className="creator-check"><input name="activeLow" type="checkbox" defaultChecked={editing&&'activeLow' in editing?editing.activeLow:defaultActiveLow} />Active low</label>}
          {(type === 'led' || type === 'max7219') && <label>LED color<select name="color" defaultValue={editing&&'color' in editing?editing.color:type==='max7219'?'red':'green'}>{['red', 'green', 'blue', 'amber', 'white'].map(color => <option key={color}>{color}</option>)}</select></label>}
          {(type === 'ws2812b'||type === 'max7219') && <label>{type==='max7219'?'Module':'LED'} count<input name="length" type="number" defaultValue={editing&&'length' in editing?editing.length:1} min={1} max={type==='max7219'?16:1024} required /></label>}
        </>}
        {Object.entries(controls(type)).map(([name, control]) => <label key={name}>Initial {control.label} ({control.unit})
          <input name={name} type="number" min={control.minimum} max={control.maximum} step="any" defaultValue={Number(manifest.inputs[editing?.id??'']?.[name]??control.initial)} required />
        </label>)}
      </div>
      {sensor && <p className="meta">I2C0 uses SDA21 / SCL22. Adding a sensor declares this bus automatically.</p>}
      {camera && <p className="meta">Uses AI-Thinker ESP32-CAM wiring: SCCB on GPIO26/27, D0-D7 on GPIO5, 18, 19, 21, 36, 39, 34, 35, VSYNC 25, HREF 23, PCLK 22, XCLK 0, PWDN 32. GPIO21/22 carry camera data, so I2C0 sensors cannot share this board. One camera per project.</p>}
      {unavailable && <p className="meta">No available wiring or device slots for this peripheral.</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <button className="primary-button" type="submit" disabled={unavailable}>{editing?<Pencil size={16}/>:<Plus size={16}/>}{editing?'Save device':'Add device'}</button>{editing&&<button type="button" onClick={cancel}>Cancel</button>}
    </form>
  </section>;
}

export function ProjectCreator() {
  const { theme, setTheme } = useTheme();
  const [session, setSession] = useCreatorSession();
  const [initial] = useState(loadDraft);
  const [draft,setDraft] = useState(initial.draft);
  const {starter,language,manifestText,blinkId,interval,lastValid}=draft;
  const [undo,setUndo]=useState<CreatorDraft|null>(null),[editId,setEditId]=useState('');
  const [storageError,setStorageError]=useState(initial.error),[fileError,setFileError]=useState('');
  const [draftError,setDraftError]=useState('');
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const output = useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{
    if(draft===initial.draft)return;
    try { localStorage.setItem(draftKey,JSON.stringify(draft));setStorageError(''); }
    catch { setStorageError('Draft storage is unavailable. Download the configuration before leaving.'); }
  },[draft,initial]);

  let manifest: ProjectManifest | null = null;
  let config: ProjectCreatorConfig | null = null;
  let error: string | null = null;
  try {
    manifest = ProjectManifestSchema.parse(JSON.parse(manifestText));
    config = ProjectCreatorConfigSchema.parse({
      v: 1, starter, language, manifest,
      ...(starter === 'blinky' ? { blink: { deviceId: blinkId, intervalMs: interval.trim() ? Number(interval) : NaN } } : {}),
    });
  } catch (failure) { error = failureText(failure); }
  const exported = config ? JSON.stringify(config) : '';
  function updateManifest(next: ProjectManifest, replacementId?: string) {
    setDraft({...draft,lastValid:next,manifestText:json(next),blinkId:editId===blinkId&&replacementId?replacementId:blinkId});setEditId('');setCopyStatus(null);
  }
  function selectStarter(value: ProjectCreatorConfig['starter'], reset=false) {
    if(!reset&&starter===value)return;
    if((lastValid.devices.length||!manifest||starter!=='empty')&&!window.confirm('Replace the current circuit draft?'))return;
    setUndo(draft);setEditId('');setCopyStatus(null);
    const next=value === 'demo' ? DEMO_MANIFEST : value === 'blinky'
      ? ProjectManifestSchema.parse({ ...EMPTY_MANIFEST, devices: [{ id: 'status_led', type: 'led', pin: 2, color: 'green' }] })
      : EMPTY_MANIFEST;
    setDraft({...draft,starter:value,blinkId:'status_led',interval:'500',lastValid:next,manifestText:json(next)});
  }
  function removeDevice(id: string) {
    if (!manifest) return;
    const removed = manifest.devices.find(device => device.id === id);
    setUndo(draft);updateManifest(ProjectManifestSchema.parse({
      ...manifest, devices: manifest.devices.filter(device => device.id !== id),
      inputs: Object.fromEntries(Object.entries(manifest.inputs).filter(([key]) => key !== id)),
      scenarios: manifest.scenarios.filter(scenario => scenario.deviceId !== id),
      gpioInputs: manifest.gpioInputs.filter(input => !removed || !isPeripheralInput(removed) || input.pin !== removed.pin),
    }));
  }
  function editJSON(text: string) {
    if(text.length>maxDraftLength){setDraftError('Circuit JSON exceeds 1 MiB of text. The previous draft is unchanged.');return;}
    setDraftError('');
    const next = { ...draft, manifestText: text };
    try { next.lastValid = ProjectManifestSchema.parse(JSON.parse(text)); } catch { /* Retain the last valid circuit. */ }
    setDraft(next);setCopyStatus(null);
  }
  function download() {
    const url=URL.createObjectURL(new Blob([exported],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='project-config.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function open(file: File) {
    setFileError('');
    try {
      if(file.size>1024*1024)throw new Error('Project configuration exceeds 1 MiB.');
      const raw:unknown=JSON.parse(await file.text());
      if(ProjectManifestSchema.safeParse(raw).success)throw new Error('This is a circuit manifest, not a project configuration.');
      const next=ProjectCreatorConfigSchema.parse(raw);
      setUndo(draft);setEditId('');setCopyStatus(null);
      setDraft({...draft,starter:next.starter,language:next.language,lastValid:next.manifest,manifestText:json(next.manifest),blinkId:next.blink?.deviceId??'status_led',interval:String(next.blink?.intervalMs??500)});
    }catch(failure){setFileError(failureText(failure));}
  }
  async function copy() {
    if (!exported) return;
    try {
      if (!navigator.clipboard) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(exported);
      setCopyStatus('JSON copied.');
    } catch (failure) {
      output.current?.focus();
      output.current?.select();
      setCopyStatus(`${failure instanceof Error ? failure.message : 'Copy failed.'} JSON selected; copy it manually.`);
    }
  }

  return <div className="app-shell">
    <header className="app-header"><div className="brand"><div className="brand-mark"><Cpu size={23} /></div><div><h1>ESPEmu</h1><span>Project Creator</span></div></div>
      <div className="runtime-tools">{!session && <a href="/">Workbench</a>}<ThemeControls theme={theme} onChange={setTheme} /></div>
    </header>
    <main className="creator-main">
      <div className="creator-heading"><h2>Create a local ESP-IDF project</h2><p>{session ? 'Name the project, choose where it goes, design the circuit, then press Create project. The setup command in your terminal creates it on this computer.' : 'No active session, firmware build, or QEMU connection required. Everything stays in your browser until you run setup locally.'}</p></div>
      <div className="creator-layout"><div>
        {session && <NewProjectCard session={session} setSession={setSession} exported={exported} valid={!!config}/>}
        <section className="creator-card">
          <h2>Starter project</h2>
          <div className="creator-fields">
            <label htmlFor="creator-starter">Starter<select id="creator-starter" aria-label="Starter" value={starter} onChange={event => selectStarter(event.target.value as ProjectCreatorConfig['starter'])}>
              <option value="empty">Empty</option><option value="blinky">Blinky</option><option value="demo">All-device demo</option>
            </select></label>
            <label htmlFor="creator-language">Language<select id="creator-language" aria-label="Language" value={language} onChange={event => { setDraft({...draft,language:event.target.value as CreatorDraft['language']}); setCopyStatus(null); }}>
              <option value="c">C</option><option value="cpp">C++</option>
            </select></label>
            {starter === 'blinky' && <>
              <label>Blink LED<select value={blinkId} onChange={event => { setDraft({...draft,blinkId:event.target.value}); setCopyStatus(null); }}>
                {manifest?.devices.filter(device => device.type === 'led').map(device => <option key={device.id} value={device.id}>{device.id}</option>)}
              </select></label>
              <label>On/off interval (ms)<input type="number" min={1} max={60000} step={1} value={interval} onChange={event => { setDraft({...draft,interval:event.target.value}); setCopyStatus(null); }} /></label>
            </>}
          </div>
          <div className="runtime-device-tools"><button type="button" onClick={()=>selectStarter('empty',true)}>Reset circuit</button>{undo&&<button type="button" onClick={()=>{setDraft(undo);setUndo(null);setEditId('');}}><Undo2 size={16}/> Undo</button>}</div>
        </section>
        {manifest && <DeviceForm key={editId} manifest={manifest} editing={manifest.devices.find(device=>device.id===editId)} save={updateManifest} cancel={()=>setEditId('')}/>}
        <section className="creator-card">
          <h2>Circuit devices</h2>
          {!(manifest??lastValid).devices.length && <p>No devices declared.</p>}
          {(manifest??lastValid).devices.map(device => <div className="creator-device" key={device.id}><span><strong>{device.id}</strong> / {device.type}<small>{isSensor(device) ? `${device.bus} / 0x${device.address.toString(16)}` : device.type === 'max7219' ? wiredPins(device).map((pin,index)=>`${['DIN','CLK','LOAD'][index]} GPIO${pin}`).join(', ') : `GPIO ${wiredPins(device).join(', ')}`}</small></span>
            <div><button type="button" className="icon-button" aria-label={`Edit ${device.id}`} disabled={!manifest} onClick={() => setEditId(device.id)}><Pencil size={16} /></button><button type="button" className="icon-button" aria-label={`Remove ${device.id}`} disabled={!manifest} onClick={() => removeDevice(device.id)}><Trash2 size={16} /></button></div></div>)}
        </section>
        <details className="creator-card"><summary>Advanced circuit configuration</summary>
          <label htmlFor="creator-circuit">Circuit JSON<textarea id="creator-circuit" aria-label="Circuit JSON" rows={16} spellCheck={false} value={manifestText} onChange={event => editJSON(event.target.value)} /></label>
        </details>
      </div><section className="creator-card creator-export">
        <h2>Project configuration</h2>
        <p>Save this JSON as <code>project-config.json</code>, then run from the ESPEmu checkout:</p>
        <pre>bash tools/setup-project.sh my_project --config project-config.json</pre>
        <p>Or pass the JSON string as a quoted argument to <code>--config-json</code>. Use <code>--config -</code> to read it from stdin.</p>
        {(draftError||error||fileError||storageError) && <p className="inline-error" role="alert">{fileError||draftError||error||storageError}</p>}
        <label>Open project configuration<input type="file" accept=".json,application/json" onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void open(file);}}/></label>
        <label htmlFor="creator-output">Project JSON<textarea id="creator-output" aria-label="Project JSON" ref={output} readOnly rows={14} spellCheck={false} value={exported} onFocus={event => event.currentTarget.select()} /></label>
        <button type="button" className="primary-button" disabled={!config} onClick={() => void copy()}><Copy size={16} />Copy JSON</button>
        <button type="button" className="primary-button" disabled={!config} onClick={download}><Download size={16}/>Download JSON</button>
        {copyStatus && <p role="status">{copyStatus}</p>}
        <p className="meta">Setup creates files only by default and refuses nonempty folders. Add --no-run to build or --run to build and launch explicitly. The exported configuration is not the circuit-only espemu.json.</p>
      </section></div>
    </main>
  </div>;
}
