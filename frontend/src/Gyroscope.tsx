import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
import { RotateCcw } from 'lucide-react';
import * as THREE from 'three';
import type { CircuitDevice } from '../../shared/registry';
import type { ModelState } from '../../shared/runtime';
import './gyroscope.css';

type Motion = Record<string, number>;
type GyroDevice = Extract<CircuitDevice, { type: 'mpu6050' }>;

export function gyroMotion(previous: THREE.Quaternion, next: THREE.Quaternion, seconds: number): Motion {
  const gravity = new THREE.Vector3(0, 0, 1).applyQuaternion(next.clone().invert());
  const delta = previous.clone().invert().multiply(next).normalize();
  if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
  const magnitude = Math.hypot(delta.x, delta.y, delta.z);
  const scale = magnitude < 1e-9 ? 0 : 2 * Math.atan2(magnitude, delta.w) * 180 / Math.PI / (magnitude * Math.max(.016, seconds));
  const rate = (value: number) => Math.round(Math.max(-2000, Math.min(2000, value * scale)) * 1000) / 1000;
  return { gyroXdps: rate(delta.x), gyroYdps: rate(delta.y), gyroZdps: rate(delta.z), accelXg: gravity.x, accelYg: gravity.y, accelZg: gravity.z };
}

function boardMesh() {
  const board = new THREE.Group();
  const substrate = new THREE.MeshStandardMaterial({ color: 0x278a65, roughness: .65 });
  const chip = new THREE.MeshStandardMaterial({ color: 0x222a2a, roughness: .45 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xb9c7c3, metalness: .8, roughness: .25 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xdcbb57, metalness: .7, roughness: .35 });
  board.add(new THREE.Mesh(new THREE.BoxGeometry(2.9, 1.8, .09), substrate));
  const sensor = new THREE.Mesh(new THREE.BoxGeometry(.74, .72, .16), chip);
  sensor.position.set(.15, .12, .12); board.add(sensor);
  for (const horizontal of [-1.2, 1.2]) for (const vertical of [-.65, .65]) {
    const hole = new THREE.Mesh(new THREE.TorusGeometry(.10, .025, 8, 24), metal);
    hole.position.set(horizontal, vertical, .06); board.add(hole);
  }
  for (let index = 0; index < 8; index++) {
    const contact = new THREE.Mesh(new THREE.BoxGeometry(.10, .20, .11), gold);
    contact.position.set(-.98 + index * .28, -.76, .09); board.add(contact);
  }
  for (const horizontal of [-.75, .85]) {
    const resistor = new THREE.Mesh(new THREE.BoxGeometry(.18, .35, .08), chip);
    resistor.position.set(horizontal, .23, .09); board.add(resistor);
  }
  const bitmap = document.createElement('canvas'); bitmap.width = 512; bitmap.height = 96;
  const context = bitmap.getContext('2d')!; context.fillStyle = '#edf7ef'; context.font = 'bold 45px monospace'; context.fillText('MPU-6050', 10, 58);
  const texture = new THREE.CanvasTexture(bitmap); texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Mesh(new THREE.PlaneGeometry(1.55, .29), new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
  label.position.set(0, .61, .052); board.add(label);
  board.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, .20), 1.8, 0xd54d5b, .20, .10));
  board.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, .20), 1.35, 0x20a071, .20, .10));
  board.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, .20), 1.15, 0x4175d8, .20, .10));
  return { board, texture };
}

export function Gyroscope({ device, inputs, model, disabled, epoch, onMotion }: { device: GyroDevice; inputs: Record<string, number | boolean>; model?: ModelState; disabled: boolean; epoch: number; onMotion: (fields: Motion, epoch: number) => Promise<void> }) {
  const canvas = useRef<HTMLCanvasElement>(null), orientation = useRef(new THREE.Quaternion());
  const pointer = useRef<{ id: number; x: number; y: number; time: number } | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ onMotion, disabled, epoch });
  const pending = useRef<Motion | null>(null), sending = useRef(false), alive = useRef(true);
  const [mode, setMode] = useState<'tilt' | 'spin'>('tilt'), [moving, setMoving] = useState(false), [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { latest.current = { onMotion, disabled, epoch }; }, [onMotion, disabled, epoch]);
  useEffect(() => {
    alive.current = true;
    const acceleration = new THREE.Vector3(Number(inputs.accelXg ?? 0), Number(inputs.accelYg ?? 0), Number(inputs.accelZg ?? 1));
    if (acceleration.length() > .01) orientation.current.setFromUnitVectors(acceleration.normalize(), new THREE.Vector3(0, 0, 1));
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ canvas: canvas.current!, antialias: true, alpha: true, preserveDrawingBuffer: true }); }
    catch { setFailure('This browser has WebGL turned off, so the 3D view cannot load.'); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x779286, 2.6));
    const light = new THREE.DirectionalLight(0xffffff, 3.5); light.position.set(2, -3, 6); scene.add(light);
    const geometry = boardMesh(); scene.add(geometry.board);
    const grid = new THREE.GridHelper(16, 32, 0xa7bcb0, 0xd0dbd5); grid.rotation.x = Math.PI / 2; grid.position.z = -1.45; scene.add(grid);
    const camera = new THREE.PerspectiveCamera(42, 1, .1, 100); camera.up.set(0, 0, 1);
    const resize = () => {
      const bounds = canvas.current!.parentElement!.getBoundingClientRect(); if (!bounds.width || !bounds.height) return;
      renderer.setSize(bounds.width, bounds.height, false); camera.aspect = bounds.width / bounds.height;
      const distance = bounds.width < 500 ? 1.35 : 1;
      camera.position.set(3 * distance, -4 * distance, 4.3 * distance); camera.lookAt(0, 0, .1); camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas.current!.parentElement!); resize();
    let frame = 0;
    const render = () => { if(canvas.current?.offsetParent!==null){geometry.board.quaternion.copy(orientation.current); renderer.render(scene, camera);} frame = requestAnimationFrame(render); }; render();
    return () => {
      if (pointer.current) void latest.current.onMotion(gyroMotion(orientation.current, orientation.current, 1), latest.current.epoch).catch(() => {});
      pointer.current = null; alive.current = false; pending.current = null; clearTimeout(idle.current); cancelAnimationFrame(frame); observer.disconnect();
      scene.traverse(object => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
          object.geometry.dispose(); for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
        }
      });
      geometry.texture.dispose(); renderer.dispose();
    };
  }, [device.id]);

  async function flush() {
    if (sending.current) return;
    sending.current = true;
    try {
      while (pending.current && alive.current && !latest.current.disabled) {
        const fields = pending.current; pending.current = null;
        await latest.current.onMotion(fields, latest.current.epoch);
      }
    } catch (error) { if (alive.current) setFailure(error instanceof Error ? error.message : 'Motion update failed'); pending.current = null; }
    finally { sending.current = false; }
  }
  function publish(fields: Motion) { if (disabled) return; pending.current = fields; void flush(); }
  function stop() { clearTimeout(idle.current); pointer.current = null; setMoving(false); publish(gyroMotion(orientation.current, orientation.current, 1)); }
  function rotate(horizontal: number, vertical: number, seconds: number) {
    const previous = orientation.current.clone();
    const delta = mode === 'spin' ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -horizontal * .009) : new THREE.Quaternion().setFromEuler(new THREE.Euler(vertical * .009, horizontal * .009, 0, 'XYZ'));
    orientation.current.multiply(delta).normalize(); publish(gyroMotion(previous, orientation.current, seconds));
    clearTimeout(idle.current); idle.current = setTimeout(() => publish(gyroMotion(orientation.current, orientation.current, 1)), 120);
  }
  function down(event: PointerEvent<HTMLCanvasElement>) { if (disabled) return; event.preventDefault(); canvas.current!.focus(); event.currentTarget.setPointerCapture(event.pointerId); pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp }; setMoving(true); }
  function move(event: PointerEvent<HTMLCanvasElement>) { const previous = pointer.current; if (!previous || previous.id !== event.pointerId || disabled) return; rotate(event.clientX - previous.x, event.clientY - previous.y, (event.timeStamp - previous.time) / 1000); pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp }; }
  function release(event: PointerEvent<HTMLCanvasElement>) { move(event); stop(); }
  function keyboard(event: KeyboardEvent<HTMLCanvasElement>) { const direction = { ArrowLeft: [-15, 0], ArrowRight: [15, 0], ArrowUp: [0, -15], ArrowDown: [0, 15] }[event.key]; if (direction && !disabled) { event.preventDefault(); rotate(direction[0], direction[1], .1); } }
  const rates = ['gyroXdps', 'gyroYdps', 'gyroZdps'], acceleration = ['accelXg', 'accelYg', 'accelZg'];
  return <section className="gyro-workbench" aria-label={`${device.id} gyroscope`}>
    <div className="section-heading"><h2>{device.label ?? 'MPU6050'}<span className="address">{device.id} / 0x{device.address.toString(16)}</span></h2>
      <div className="gyro-toolbar"><div className="gyro-modes" role="group" aria-label={`${device.id} rotation mode`}><button aria-pressed={mode === 'tilt'} title="Tilt sensor" onClick={() => setMode('tilt')}>Tilt</button><button aria-pressed={mode === 'spin'} title="Rotate around sensor Z" onClick={() => setMode('spin')}>Spin</button></div><button className="gyro-reset" title="Reset orientation" aria-label={`Reset ${device.id} orientation`} disabled={disabled} onClick={() => { orientation.current.identity(); stop(); }}><RotateCcw size={17}/></button></div>
    </div>
    {failure && <div role="alert" className="field-error">{failure}</div>}
    <div className="gyro-layout"><div className={`gyro-viewport ${moving ? 'gyro-dragging' : ''}`}><canvas ref={canvas} className="gyro-canvas" data-gyro-id={device.id} role="img" aria-label={`${device.id} draggable gyroscope`} tabIndex={disabled ? -1 : 0} onPointerDown={down} onPointerMove={move} onPointerUp={release} onPointerCancel={stop} onLostPointerCapture={() => { if (pointer.current) stop(); }} onKeyDown={keyboard}/></div>
      <div className="gyro-readouts"><h3>Angular rate<span className="unit">deg/s</span></h3>{rates.map((name, index) => <div className="gyro-axis" key={name}><span className={`axis-${index}`}>{['X', 'Y', 'Z'][index]}</span><output aria-label={`${device.id} ${name} motion`}>{Number(inputs[name] ?? 0).toFixed(1)}</output></div>)}<h3>Acceleration<span className="unit">g</span></h3>{acceleration.map((name, index) => <div className="gyro-axis" key={name}><span className={`axis-${index}`}>{['X', 'Y', 'Z'][index]}</span><output aria-label={`${device.id} ${name} motion`}>{Number(inputs[name] ?? (index === 2 ? 1 : 0)).toFixed(3)}</output></div>)}<span className="reading-status">{model?.status ?? 'unavailable'}</span></div>
    </div>
  </section>;
}
