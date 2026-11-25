import { StrictMode, Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Cpu, Play, Pause, RotateCcw, Square, Download, Activity, Terminal, Zap, RefreshCw, Undo2, X } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Tab, Tabs } from 'react-bootstrap';
import { useProjectSession } from './useProjectSession';
import { PeripheralsPanel } from './PeripheralsPanel';
import { ThemeControls, useTheme } from './ThemeControls';
import { SerialMonitor, useConsoleTail } from './SerialMonitor';
import { ProjectManifestSchema, type CircuitScenario } from '../../shared/manifest';
import { controls, isCamera, isSensor, isSpeaker, normalizeInputs, wiredPins, type CircuitDevice } from '../../shared/registry';
import { CameraPanel } from './CameraPanel';
import { LcdPanel } from './LcdPanel';
import { SpeakerPanel } from './SpeakerPanel';
import type { ProjectState } from '../../shared/runtime';
import 'bootstrap/dist/css/bootstrap.min.css';
import './styles.css';
import './project.css';

// Three.js and the creator load on demand so the workbench's first paint stays small.
const Gyroscope = lazy(() => import('./Gyroscope').then(module => ({ default: module.Gyroscope })));
const ProjectCreator = lazy(() => import('./ProjectCreator').then(module => ({ default: module.ProjectCreator })));

function bitmap(devices: CircuitDevice[], compact: boolean) {
  const columns=compact?1:4;
  const canvas=document.createElement('canvas');canvas.width=compact?360:1000;canvas.height=110+Math.ceil(devices.length/columns)*64;
  const context=canvas.getContext('2d')!;context.fillStyle='#f4f8f6';context.fillRect(0,0,canvas.width,canvas.height);
  context.fillStyle='#243a31';context.fillRect(20,20,180,64);context.font='bold 24px monospace';context.fillStyle='#ffffff';context.fillText('ESP32',55,59);
  context.strokeStyle='#73a391';context.lineWidth=2;context.beginPath();context.moveTo(200,53);context.lineTo(canvas.width-20,53);context.stroke();
  devices.forEach((device,index)=>{const x=20+(index%columns)*245,y=105+Math.floor(index/columns)*64;context.strokeStyle='#b2c4ba';context.strokeRect(x,y-9,compact?320:230,52);context.fillStyle='#273a30';context.font=`${compact?16:13}px monospace`;context.fillText(`${device.id.slice(0,14)} / ${device.type}`,x+8,y+9);context.fillStyle='#507665';context.font=`${compact?14:11}px monospace`;context.fillText(isSensor(device)?`${device.bus} : 0x${device.address.toString(16)}`:isCamera(device)?`SCCB ${device.signals.sda}/${device.signals.scl} · VSYNC ${device.signals.vsync} · DVP`:`GPIO ${wiredPins(device).join(', ')}`,x+8,y+29);});
  return canvas.toDataURL('image/png');
}
function InputNumber({value,disabled,minimum,maximum,step,label,commit,automated=false}:{value:number;disabled:boolean;minimum:number;maximum:number;step:number;label:string;commit:(value:number)=>Promise<void>;automated?:boolean}) {
  const [draft,setDraft]=useState<string|null>(null),[pending,setPending]=useState(false),[error,setError]=useState('');
  const origin=useRef<number|null>(null);
  async function finish(text:string){
    const before=origin.current;origin.current=null;setDraft(null);
    if(before===null||disabled||pending||text===String(before))return;
    if(before!==value&&!automated){setError('Value changed during editing. Edit the current value again.');return;}
    const next=Number(text);
    if(!text.trim()||!Number.isFinite(next)||next<minimum||next>maximum){setError(`Enter a value from ${minimum} to ${maximum}.`);return;}
    if(next===value)return;
    setError('');setPending(true);
    try{await commit(next);}catch(failure){setError(failure instanceof Error?failure.message:'Input rejected');}finally{setPending(false);}
  }
  return <span className="runtime-field"><input type="number" aria-label={label} aria-invalid={!!error} min={minimum} max={maximum} step={step} value={draft??String(value)} disabled={disabled||pending}
    onFocus={()=>{origin.current=value;setDraft(String(value));setError('');}} onChange={event=>setDraft(event.target.value)} onBlur={event=>void finish(event.currentTarget.value)}
    onKeyDown={event=>{if(event.key==='Enter'||event.key==='Escape'){event.preventDefault();if(event.key==='Escape'){origin.current=null;setDraft(null);setError('');}event.currentTarget.blur();}}}/>
    {automated&&!pending&&<span className="meta scenario-driven" title="A running scenario drives this value. Enter a value to override it manually.">Scenario</span>}{pending&&<span className="meta" role="status">Pending</span>}{error&&<span className="field-error" role="alert">{error}</span>}</span>;
}
function InputFlag({value,disabled,label,commit}:{value:boolean;disabled:boolean;label:string;commit:(value:boolean)=>Promise<void>}) {
  const [pending,setPending]=useState(false),[error,setError]=useState('');
  async function update(next:boolean){setPending(true);setError('');try{await commit(next);}catch(failure){setError(failure instanceof Error?failure.message:'Input rejected');}finally{setPending(false);}}
  return <><input type="checkbox" aria-label={label} checked={value} disabled={disabled||pending} onChange={event=>void update(event.target.checked)}/>{pending&&<span className="meta" role="status">Pending</span>}{error&&<span className="field-error" role="alert">{error}</span>}</>;
}
const consoleDocks=['off','serial','events','both'] as const;
type ConsoleDock=typeof consoleDocks[number];

function EventTimeline({events,sessionId}:{events:ProjectState['events'];sessionId?:string}) {
  const [search,setSearch]=useState(''),[follow,setFollow]=useState(true);
  const scroll=useConsoleTail<HTMLDivElement>(follow,events,search);
  const visible=events.filter(event=>`${event.source} ${event.message}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="runtime-event-view"><div className="section-heading"><h2><Zap size={17}/>Event Timeline</h2></div>
    <div className="runtime-device-tools"><label>Filter events <input type="search" value={search} onChange={event=>setSearch(event.target.value)}/></label><label><input type="checkbox" checked={follow} onChange={event=>setFollow(event.target.checked)}/> Follow latest</label></div>
    <div className="runtime-events" ref={scroll} role="log" aria-label="Runtime events" aria-live="off" tabIndex={0}>{visible.map(event=><div key={`${sessionId}:${event.epoch}:${event.seq}`}><span>{(event.virtualMs/1000).toFixed(2)}s</span><b>{event.source}</b><span>{event.message}</span></div>)}</div>
  </section>;
}

function App() {
  const session=useProjectSession();const {state,connection}=session;
  const {theme,setTheme}=useTheme();
  const [image,setImage]=useState(''),[selected,setSelected]=useState('');
  const [scenarioDraft,setScenario]=useState<CircuitScenario>({deviceId:'',channel:'',kind:'manual',offset:0,amplitude:0,periodMs:10000,seed:42,frames:[]});
  const [frames,setFrames]=useState('[]');
  const [deviceSearch,setDeviceSearch]=useState(''),[inspector,setInspector]=useState('');
  const [pinned,setPinned]=useState<string[]>([]);
  const pinnedKey=state?.projectName?`espemu.pinned.${state.projectName}`:null;
  // Pinned signals are a per-project browser preference, never part of the manifest.
  useEffect(()=>{if(!pinnedKey)return;try{const saved=JSON.parse(localStorage.getItem(pinnedKey)??'[]');setPinned(Array.isArray(saved)?saved.filter((key):key is string=>typeof key==='string').slice(0,12):[]);}catch{setPinned([]);}},[pinnedKey]);
  function pin(next:string[]){setPinned(next);if(pinnedKey)try{localStorage.setItem(pinnedKey,JSON.stringify(next));}catch{/* storage denied: keep the in-memory list */}}
  const [chartWindow,setChartWindow]=useState(30),[chartAnchor,setChartAnchor]=useState<number|null>(null);
  const [activeTab,setActiveTab]=useState('circuit');
  const [dock,setDock]=useState<ConsoleDock>(()=>matchMedia('(min-width:1100px)').matches?'both':'off');
  const [pendingAction,setPendingAction]=useState(false), actionLock=useRef(false);
  const devices=state?.manifest.devices??[];
  const matching=devices.filter(device=>`${device.id} ${device.label??''} ${device.type}`.toLowerCase().includes(deviceSearch.trim().toLowerCase()));
  const inspected=matching.some(device=>device.id===inspector)?matching.filter(device=>device.id===inspector):matching;
  const visibleDevices=new Set(inspected.map(device=>device.id));
  const sensors=inspected.filter(isSensor);
  const key=JSON.stringify(devices);
  useEffect(()=>{const media=matchMedia('(max-width:600px)');const render=()=>setImage(bitmap(devices,media.matches));render();media.addEventListener('change',render);return()=>media.removeEventListener('change',render);},[key]);
  const disabled=connection!=='online'||!state||state.phase==='error'||state.phase==='starting';
  const scope=`${connection}:${state?.sessionId}:${state?.epoch}`;
  const freshness=connection!=='online'?'Stale':state?.phase==='stopped'?'Staged':state?.phase==='paused'?'Paused':state?.phase==='running'?'Live':'Unavailable';
  const canCommand=(action:string)=>connection==='online'&&!!state&&!pendingAction&&(
    action==='run'?['paused','stopped','error'].includes(state.phase):action==='pause'?state.phase==='running':action==='reset'?['running','paused'].includes(state.phase):action==='stop'?['running','paused','error'].includes(state.phase):!disabled);
  async function perform(operation:()=>Promise<void>){try{session.reportError(null);await operation();}catch(error){session.reportError(error instanceof Error?error.message:'Command failed');}}
  function command(action:'run'|'pause'|'reset'|'stop'|'restore-environment'){
    if(actionLock.current||!canCommand(action))return;
    actionLock.current=true;setPendingAction(true);
    void perform(()=>session.send({action})).finally(()=>{actionLock.current=false;setPendingAction(false);});
  }
  function exportCircuit(){if(!state)return;const project=ProjectManifestSchema.parse({...state.manifest,inputs:state.inputs,gpioInputs:state.gpioInputs,scenarios:state.scenarios});const url=URL.createObjectURL(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}));const anchor=document.createElement('a');anchor.href=url;anchor.download='espemu.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  async function input(device:CircuitDevice,name:string,value:number|boolean){
    if(!state)throw new Error('No live project connection');
    normalizeInputs([device],{[device.id]:{...state.inputs[device.id],[name]:value}});
    await session.send({action:'input',deviceId:device.id,channel:name,value},state.epoch);
  }
  const channels=Object.keys(state?.latest?.channels??{});const chartChannel=channels.includes(selected)?selected:channels[0];
  const application=state?.latest?.channels[chartChannel??''];
  const chartEnd=chartAnchor??(state?.virtualMs??0)/1000;
  const samples=(state?.history??[]).filter(sample=>sample.epoch===state?.epoch&&sample.virtualMs/1000<=chartEnd&&sample.virtualMs/1000>=chartEnd-chartWindow).map(sample=>({time:sample.virtualMs/1000,value:sample.channels[chartChannel??'']?.unit===application?.unit?sample.channels[chartChannel??'']?.value??null:null}));
  const gpioChoices=devices.flatMap(device=>isSensor(device)?[]:wiredPins(device).map(number=>({ key:`gpio:${device.id}:${number}`, number, label:`${device.label??device.id} · GPIO${number}` })));
  const applicationChoices=channels.map(name=>({key:`app:${name}`,name,label:name}));
  const unpinnedGpio=gpioChoices.filter(choice=>!pinned.includes(choice.key)),unpinnedApplication=applicationChoices.filter(choice=>!pinned.includes(choice.key));
  const pinnedRows=pinned.map(key=>{
    const gpio=gpioChoices.find(choice=>choice.key===key);
    if(gpio){const observed=state?.gpio?.pins.find(entry=>entry.pin===gpio.number);return {key,label:gpio.label,source:'GPIO',value:observed?`${observed.level?'HIGH':'LOW'} · ${observed.outputEnabled?'Output':'Input'}`:'Unavailable'};}
    if(!key.startsWith('app:'))return {key,label:`${key.split(':')[1]??key} · GPIO${key.split(':')[2]??'?'}`,source:'GPIO',value:'Not in this circuit'};
    const name=key.slice(4),sample=state?.latest?.channels[name];
    return {key,label:name,source:'Application',value:sample?.value==null?'Unavailable':`${Number.isInteger(sample.value)?sample.value:sample.value.toFixed(2)} ${sample.unit}`.trim()};
  });
  const targets=sensors.flatMap(device=>Object.entries(controls(device.type)).map(([name,control])=>({key:`${device.id}:${name}`,deviceId:device.id,channel:name,control})));
  const scenarioTarget=targets.find(target=>target.deviceId===scenarioDraft.deviceId&&target.channel===scenarioDraft.channel)??targets[0];
  const currentScenario=state?.scenarios.find(value=>value.deviceId===scenarioTarget?.deviceId&&value.channel===scenarioTarget?.channel);
  const scenario=scenarioTarget&&scenarioDraft.deviceId===scenarioTarget.deviceId&&scenarioDraft.channel===scenarioTarget.channel
    ?scenarioDraft:currentScenario??{deviceId:scenarioTarget?.deviceId??'',channel:scenarioTarget?.channel??'',kind:'manual',offset:scenarioTarget?.control.initial??0,amplitude:0,periodMs:10000,seed:42,frames:[]};
  const run=scenarioTarget?state?.scenarioRuns?.[scenarioTarget.key]:undefined;
  const elapsed=state?Math.max(0,state.virtualMs-(run?.originMs??0)):0;
  const duration=currentScenario?.kind==='playback'?currentScenario.frames.at(-1)?.timeMs:undefined;
  const scenarioStatus=run?.status==='stopped'?'Stopped · value retained':run?.status==='completed'?'Completed · final value retained':run?.status==='overridden'?'Manual override':!currentScenario||currentScenario.kind==='manual'?'Manual':`${run?'Active':'Epoch-relative'} · ${(Math.min(elapsed,duration??Infinity)/1000).toFixed(2)}${duration===undefined?'':` / ${(duration/1000).toFixed(2)}`} s`;
  function editFrame(index:number,field:'timeMs'|'value',value:number){
    setScenario({...scenario,frames:scenario.frames.map((frame,position)=>position===index?{...frame,[field]:value}:frame)});
  }
  const dockSerial=activeTab!=='serial'&&(dock==='serial'||dock==='both');
  const dockEvents=activeTab!=='events'&&(dock==='events'||dock==='both');
  const serial=<SerialMonitor lines={state?.console??[]} disabled={disabled} onClear={()=>perform(()=>session.send({action:'console-clear'}))}/>;
  const events=<EventTimeline events={state?.events??[]} sessionId={state?.sessionId}/>;
  return <div className="app-shell"><header className="app-header"><div className="brand"><div className="brand-mark"><Cpu size={23}/></div><div><h1>ESPEmu</h1><span>{state?.projectName||'Project Workbench'}{state&&` / ${state.manifest.target}`}</span></div></div><div className="header-session"><span className={`connection-dot ${connection}`}/><span>{connection}</span><span className={`phase phase-${state?.phase??'starting'}`}>{state?.phase??'starting'}</span>{state&&<span>{freshness} · {(state.virtualMs/1000).toFixed(2)} s · Epoch {state.epoch}</span>}</div>
    <div className="runtime-tools">{([{action:'run',icon:<Play size={18}/>},{action:'pause',icon:<Pause size={18}/>},{action:'reset',icon:<RotateCcw size={18}/>},{action:'stop',icon:<Square size={18}/>} ] as const).map(tool=><button key={tool.action} aria-label={tool.action} title={tool.action} disabled={!canCommand(tool.action)} onClick={()=>command(tool.action)}>{tool.icon}</button>)}
      <button aria-label="Restore environment defaults" title="Restore environment defaults" disabled={!canCommand('restore-environment')} onClick={()=>command('restore-environment')}><Undo2 size={18}/></button>{connection==='offline'&&<button aria-label="Reconnect" title="Reconnect" onClick={session.reconnect}><RefreshCw size={18}/></button>}
      <button aria-label="Export circuit" title="Export circuit" onClick={exportCircuit} disabled={!state}><Download size={18}/></button><a href="/create">Create project</a><ThemeControls theme={theme} onChange={setTheme}/></div>
  </header>{(session.error||state?.error)&&<div className="error-banner" role="alert">{session.error??state?.error}</div>}
  <main className="project-main"><div className="runtime-device-tools workbench-controls">{!!devices.length&&<><label>Find device <input type="search" value={deviceSearch} onChange={event=>{setDeviceSearch(event.target.value);setInspector('');}}/></label><label>Inspect <select value={inspector} onChange={event=>setInspector(event.target.value)}><option value="">All matching devices</option>{matching.map(device=><option key={device.id} value={device.id}>{device.label??device.id} / {device.type}</option>)}</select></label>{!matching.length&&<span className="meta">No matching devices</span>}</>}
    <label className="console-dock-control"><Terminal size={15} aria-hidden="true"/> Console dock <select value={dock} onChange={event=>setDock(event.target.value as ConsoleDock)}>{consoleDocks.map((value,index)=><option key={value} value={value}>{['Off','Serial','Events','Serial + Events'][index]}</option>)}</select></label>
  </div><div className={`workbench-layout${dockSerial||dockEvents?' workbench-layout-docked':''}`}><div className="workbench-primary"><Tabs activeKey={activeTab} onSelect={tab=>{if(tab)setActiveTab(tab);}} id="workbench-tabs" mountOnEnter transition={false}>
    <Tab eventKey="circuit" title={<><Cpu size={16}/>Circuit</>}>
    <Suspense fallback={<p className="meta">Loading 3D view</p>}>{inspected.filter((device):device is Extract<CircuitDevice,{type:'mpu6050'}>=>device.type==='mpu6050').map(device=><Gyroscope key={`${scope}:${device.id}`} device={device} inputs={state?.inputs[device.id]??{}} model={state?.deviceStates[device.id]} disabled={disabled} epoch={state?.epoch??0} onMotion={(fields,epoch)=>session.send({action:'input-fields',deviceId:device.id,fields},epoch)}/>)}</Suspense>{inspected.filter((device):device is Extract<CircuitDevice,{type:'hd44780'}>=>device.type==='hd44780').map(device=><LcdPanel key={device.id} device={device} model={state?.deviceStates[device.id]}/>)}{inspected.filter(isSpeaker).map(device=><SpeakerPanel key={device.id} device={device} speaker={state?.speaker} subscribe={session.subscribeAudio}/>)}{inspected.filter(isCamera).map(device=><CameraPanel key={device.id} device={device} camera={state?.camera} disabled={disabled} running={state?.phase==='running'} epoch={state?.epoch??0} send={session.send}/>)}<PeripheralsPanel key={scope} state={state} disabled={disabled||state?.phase==='stopped'} disconnected={connection!=='online'} filter={visibleDevices} send={session.send} sendPin={session.send}/>
    <section className="runtime-circuit"><div className="section-heading"><h2><Cpu size={17}/>Logical Circuit</h2><span className="meta">{state?.manifest.target??'esp32'}</span></div>{image&&<img className="runtime-bitmap" src={image} alt="Declared ESP32 circuit"/>}<details><summary>Wiring reference</summary><ul>{inspected.map(device=><li key={device.id}>{device.id} / {device.type} / {isSensor(device)?`${device.bus} · 0x${device.address.toString(16)}`:`GPIO ${wiredPins(device).join(', ')}`}</li>)}</ul></details></section>
    </Tab><Tab eventKey="inputs" title={<><Activity size={16}/>Inputs</>}>
    <div className="runtime-grid"><aside><div className="section-heading"><h2>Physical Inputs</h2><span className="meta">{freshness}</span></div>{sensors.map(device=><section className="runtime-input-device" aria-label={`${device.id} physical inputs`} key={`${scope}:${device.id}`}><h3>{device.label??device.id}<span className="address">{device.id} / {device.type} / 0x{device.address.toString(16)}</span></h3>{Object.entries(controls(device.type)).map(([name,control])=><label className="runtime-input" key={name}>{control.label}<span className="unit">{control.unit}</span><InputNumber label={`${device.id} ${name} input`} minimum={control.minimum} maximum={control.maximum} step={control.step} value={Number(state?.inputs[device.id]?.[name]??control.initial)} automated={!!state?.scenarios.some(scenario=>scenario.deviceId===device.id&&scenario.channel===name&&scenario.kind!=='manual'&&(state.scenarioRuns?.[`${device.id}:${name}`]?.status??'active')==='active')} disabled={disabled} commit={value=>input(device,name,value)}/></label>)}<div className="fault-row"><label><InputFlag label={`${device.id} connected`} value={!!state?.inputs[device.id]?.connected} disabled={disabled} commit={value=>input(device,'connected',value)}/>Connected</label>{Object.keys(controls(device.type)).length>0&&<label><InputFlag label={`${device.id} invalid`} value={!!state?.inputs[device.id]?.invalid} disabled={disabled} commit={value=>input(device,'invalid',value)}/>Invalid</label>}</div><span className="meta">{freshness} / {state?.inputs[device.id]?.connected?'connected':'disconnected'} / {state?.inputs[device.id]?.invalid?'invalid':'valid'}</span></section>)}
    {scenarioTarget&&<section className="runtime-scenarios"><h2>Input Scenario</h2>
      <output className="meta" aria-label="Scenario status">{scenarioStatus}</output>
      <label>Channel<select aria-label="Scenario channel" value={scenarioTarget.key} onChange={event=>{const target=targets.find(entry=>entry.key===event.target.value)!;const saved=state?.scenarios.find(entry=>entry.deviceId===target.deviceId&&entry.channel===target.channel);setScenario(saved??{deviceId:target.deviceId,channel:target.channel,kind:'manual',offset:target.control.initial,amplitude:0,periodMs:10000,seed:42,frames:[]});setFrames('[]');}}>{targets.map(target=><option key={target.key}>{target.key}</option>)}</select></label>
      <label>Mode<select aria-label="Scenario mode" value={scenario.kind} onChange={event=>{const kind=event.target.value as CircuitScenario['kind'];setScenario({...scenario,kind,frames:kind==='playback'&&!scenario.frames.length?[{timeMs:0,value:scenarioTarget.control.initial},{timeMs:6000,value:scenarioTarget.control.initial}]:scenario.frames});}}>{['manual','ramp','sine','noise','playback'].map(value=><option key={value}>{value}</option>)}</select></label>
      {scenario.kind!=='manual'&&scenario.kind!=='playback'&&(['offset','amplitude',...(scenario.kind==='noise'?['seed'] as const:['periodMs'] as const)] as const).map(name=><label key={name}>{name} {name==='periodMs'?'(ms)':name==='seed'?'':`(${scenarioTarget.control.unit})`}<input aria-label={`Scenario ${name}`} type="number" step="any" value={scenario[name]} onChange={event=>setScenario({...scenario,[name]:Number(event.target.value)})}/></label>)}
      {scenario.kind==='playback'&&<><div className="runtime-frames">{scenario.frames.slice(0,32).map((frame,index)=><div key={index} className="runtime-device-tools"><label>Time (ms)<input aria-label={`Frame ${index+1} time`} type="number" min={0} value={frame.timeMs} onChange={event=>editFrame(index,'timeMs',Number(event.target.value))}/></label><label>Value ({scenarioTarget.control.unit})<input aria-label={`Frame ${index+1} value`} type="number" step="any" value={frame.value} onChange={event=>editFrame(index,'value',Number(event.target.value))}/></label><button type="button" aria-label={`Remove frame ${index+1}`} disabled={scenario.frames.length<=1} onClick={()=>setScenario({...scenario,frames:scenario.frames.filter((_,position)=>position!==index)})}>Remove</button></div>)}</div><button type="button" disabled={scenario.frames.length>=32} onClick={()=>setScenario({...scenario,frames:[...scenario.frames,{timeMs:(scenario.frames.at(-1)?.timeMs??0)+1000,value:scenario.frames.at(-1)?.value??scenarioTarget.control.initial}]})}>Add frame</button><details><summary>Playback JSON</summary><textarea aria-label="Playback frames JSON" value={frames} onChange={event=>setFrames(event.target.value)}/><button type="button" onClick={()=>void perform(async()=>{const file=ProjectManifestSchema.parse({...state!.manifest,scenarios:[{...scenario,deviceId:scenarioTarget.deviceId,channel:scenarioTarget.channel,frames:JSON.parse(frames)}]});setScenario({...scenario,frames:file.scenarios[0].frames});})}>Load frames</button></details></>}
      <div className="runtime-device-tools"><button className="primary-button" disabled={disabled||scenario.kind==='manual'} onClick={()=>void perform(()=>session.send({action:'scenario-start',scenario:{...scenario,deviceId:scenarioTarget.deviceId,channel:scenarioTarget.channel,frames:scenario.kind==='playback'?scenario.frames:[]}}))}>{currentScenario?'Replay':'Start'}</button><button disabled={disabled||!currentScenario||run?.status==='stopped'} onClick={()=>void perform(()=>session.send({action:'scenario-stop',deviceId:scenarioTarget.deviceId,channel:scenarioTarget.channel}))}>Stop scenario</button></div>
    </section>}</aside>
    <div><section className="runtime-observations" aria-label="Pinned observations"><div className="section-heading"><h2>Pinned Observations</h2><span className="meta">{freshness==='Staged'?'Last observed':freshness}</span></div><div className="runtime-device-tools"><label>Pin a signal<select value="" onChange={event=>{if(event.target.value)pin([...pinned.filter(key=>key!==event.target.value),event.target.value].slice(-12));}}><option value="">{gpioChoices.length||applicationChoices.length?'Choose a signal':'No GPIO or application signals'}</option>{unpinnedGpio.length>0&&<optgroup label="GPIO">{unpinnedGpio.map(choice=><option key={choice.key} value={choice.key}>{choice.label}</option>)}</optgroup>}{unpinnedApplication.length>0&&<optgroup label="Application">{unpinnedApplication.map(choice=><option key={choice.key} value={choice.key}>{choice.label}</option>)}</optgroup>}</select></label></div>
      {pinnedRows.length>0&&<ul className="pinned-signals" aria-label="Pinned signals">{pinnedRows.map(row=><li key={row.key} data-pinned={row.key}><span className="meta">{row.source}</span><span className="pinned-label">{row.label}</span><output aria-label={`${row.label} value`}>{row.value}</output><button type="button" aria-label={`Unpin ${row.label}`} title="Unpin" onClick={()=>pin(pinned.filter(key=>key!==row.key))}><X size={14}/></button></li>)}</ul>}</section><section className="runtime-models"><div className="section-heading"><h2>QEMU Device State</h2><span className="meta">{freshness==='Staged'?'Last observed':freshness}</span></div><div className="runtime-model-grid">{sensors.map(device=><article className="runtime-model" aria-label={`${device.id} QEMU state`} data-device={device.id} key={device.id}><h3>{device.label??device.id}<span className="address">{device.id} / {device.type}</span></h3><span className="reading-status">{state?.deviceStates[device.id]?.status??'unavailable'}</span>{Object.entries(controls(device.type)).map(([name,control])=><div className="reading" key={name}><span title={`${control.minimum} to ${control.maximum} ${control.unit}; input step ${control.step}`}>{control.label}</span><div><strong data-channel={name}>{state?.deviceStates[device.id]?.channels[name]==null?'--':Number(state.deviceStates[device.id].channels[name]).toFixed(2)}</strong><span className="unit">{control.unit}</span></div></div>)}</article>)}</div></section></div></div>
    </Tab><Tab eventKey="application" title={<><Activity size={16}/>Application</>}>
    <section className="runtime-application"><div className="section-heading"><h2><Activity size={17}/>Application Observations</h2><span className="meta">{freshness} / Epoch {state?.epoch??'--'}</span></div><div className="runtime-channel-values">{Object.entries(state?.latest?.channels??{}).map(([name,channel])=><div key={name}><span>{name}</span><strong>{channel.value==null?'--':channel.value.toFixed(2)}</strong><span className="unit">{channel.unit}</span></div>)}</div>{channels.length>0?<><div className="runtime-device-tools"><label>Channel<select aria-label="Application chart channel" value={chartChannel} onChange={event=>setSelected(event.target.value)}>{channels.map(channel=><option key={channel}>{channel}</option>)}</select></label><label>Window<select value={chartWindow} onChange={event=>setChartWindow(Number(event.target.value))}>{[10,30,60].map(seconds=><option key={seconds} value={seconds}>{seconds} s</option>)}</select></label><label><input type="checkbox" checked={chartAnchor===null} onChange={event=>setChartAnchor(event.target.checked?null:chartEnd)}/> Follow live</label></div><div className="runtime-chart" key={scope}><ResponsiveContainer width="100%" height="100%"><LineChart data={samples} margin={{bottom:16}}><CartesianGrid stroke="var(--line)"/><XAxis dataKey="time" type="number" domain={[Math.max(0,chartEnd-chartWindow),Math.max(1,chartEnd)]} allowDataOverflow tick={{fontSize:11}} label={{value:'Virtual time (s)',position:'insideBottom',offset:-9}}/><YAxis width={55} tick={{fontSize:11}} unit={application?.unit?` ${application.unit}`:undefined}/><Tooltip formatter={value=>`${value} ${application?.unit??''}`}/><Line dataKey="value" stroke="var(--teal)" dot={false} isAnimationActive={false} connectNulls={false}/></LineChart></ResponsiveContainer></div></>:<p className="meta">No application telemetry</p>}</section>
    </Tab><Tab eventKey="serial" title={<><Terminal size={16}/>Serial</>}>{activeTab==='serial'&&serial}</Tab>
    <Tab eventKey="events" title={<><Zap size={16}/>Events</>}>{activeTab==='events'&&events}</Tab>
  </Tabs></div>{(dockSerial||dockEvents)&&<aside className="workbench-dock" aria-label="Console dock">{dockSerial&&serial}{dockEvents&&events}</aside>}</div></main></div>;
}
createRoot(document.getElementById('root')!).render(<StrictMode>{location.pathname.replace(/\/+$/, '') === '/create' ? <Suspense fallback={<p className="meta">Loading creator</p>}><ProjectCreator/></Suspense> : <App/>}</StrictMode>);
