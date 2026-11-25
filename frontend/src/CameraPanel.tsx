import { useEffect, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { base64Bytes, rgbaToRgb565, rgbaToYuyv, testPattern, type CameraState } from '../../shared/camera';
import type { CircuitDevice } from '../../shared/registry';
import type { RuntimeCommand } from '../../shared/runtime';

type Command<Action> = Omit<Extract<RuntimeCommand, { action: Action }>, 'v' | 'id' | 'epoch' | 'sessionId'>;
type FramePayload = Command<'camera-frame'> | Command<'camera-clear'>;
type Source = 'off' | 'pattern' | 'webcam';
const FRAME_INTERVAL_MS = 200;

/** JPEG quality drops until the frame fits a budget close to OV2640 output at esp32-camera's default quality. */
async function jpegBytes(canvas: HTMLCanvasElement, budget: number): Promise<Uint8Array> {
  let bytes = new Uint8Array();
  for (const quality of [0.8, 0.6, 0.45, 0.3, 0.2, 0.1, 0.05]) {
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('This browser cannot encode JPEG');
    bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length <= budget) break;
  }
  return bytes;
}

export function CameraPanel({ device, camera, disabled, running, epoch, send }: {
  device: Extract<CircuitDevice, { type: 'ov2640' }>; camera: CameraState | null | undefined; disabled: boolean; running: boolean; epoch: number;
  send: (payload: FramePayload, epoch?: number) => Promise<void>;
}) {
  const [source, setSource] = useState<Source>('off');
  const [error, setError] = useState('');
  const [sent, setSent] = useState<{ count: number; bytes: number }>({ count: 0, bytes: 0 });
  const video = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const sensor = camera?.sensor;
  const ready = !!sensor && sensor.width > 0 && sensor.height > 0;
  const format = sensor?.format, width = sensor?.width ?? 0, height = sensor?.height ?? 0;

  useEffect(() => {
    if (source !== 'webcam') return;
    let stream: MediaStream | null = null, cancelled = false;
    setError('');
    if (!navigator.mediaDevices?.getUserMedia) { setError('Webcam capture needs a secure page. Open the workbench through localhost or HTTPS.'); setSource('off'); return; }
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }).then(media => {
      if (cancelled) { media.getTracks().forEach(track => track.stop()); return; }
      stream = media;
      if (video.current) { video.current.srcObject = media; void video.current.play().catch(() => {}); }
    }).catch((failure: unknown) => { if (!cancelled) { setError(failure instanceof Error ? `Webcam unavailable: ${failure.message}` : 'Webcam unavailable'); setSource('off'); } });
    return () => { cancelled = true; stream?.getTracks().forEach(track => track.stop()); if (video.current) video.current.srcObject = null; };
  }, [source]);

  useEffect(() => {
    if (source === 'off' || disabled || !running || !ready || !format) return;
    let stopped = false, frame = 0, timer: ReturnType<typeof setTimeout> | undefined;
    async function capture() {
      const target = canvas.current, context = target?.getContext('2d', { willReadFrequently: true });
      if (!target || !context) return;
      target.width = width; target.height = height;
      if (source === 'pattern') context.putImageData(new ImageData(testPattern(width, height, frame * 4), width, height), 0, 0);
      else {
        const feed = video.current;
        if (!feed || feed.readyState < 2 || !feed.videoWidth) return;
        // Crop to the sensor's aspect ratio, as a lens would frame it, instead of stretching.
        const scale = Math.max(width / feed.videoWidth, height / feed.videoHeight);
        const cropWidth = width / scale, cropHeight = height / scale;
        context.drawImage(feed, (feed.videoWidth - cropWidth) / 2, (feed.videoHeight - cropHeight) / 2, cropWidth, cropHeight, 0, 0, width, height);
      }
      frame++;
      const bytes = format === 'jpeg' ? await jpegBytes(target, Math.floor(width * height / 8))
        : (format === 'rgb565' ? rgbaToRgb565 : rgbaToYuyv)(context.getImageData(0, 0, width, height).data, width, height);
      if (stopped) return;
      await send({ action: 'camera-frame', deviceId: device.id, frame: { format: format!, width, height, data: base64Bytes(bytes) } }, epoch);
      setSent(previous => ({ count: previous.count + 1, bytes: bytes.length }));
    }
    async function loop() {
      const started = performance.now();
      try { await capture(); if (!stopped) setError(''); }
      catch (failure) { if (!stopped) setError(failure instanceof Error ? failure.message : 'Frame rejected'); }
      if (!stopped) timer = setTimeout(loop, Math.max(0, FRAME_INTERVAL_MS - (performance.now() - started)));
    }
    void loop();
    return () => { stopped = true; clearTimeout(timer); };
  }, [source, disabled, running, ready, format, width, height, device.id, epoch]);

  function select(next: Source) {
    setSource(next); setSent({ count: 0, bytes: 0 }); setError('');
    // Choosing Off removes the picture so firmware stops receiving frames instead of repeating the last one.
    if (next === 'off' && camera?.source) send({ action: 'camera-clear', deviceId: device.id }, epoch).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Could not clear the camera'));
  }
  const status = !camera ? 'Waiting for QEMU' : !ready ? 'Waiting for firmware to configure the sensor' : camera.status;
  return <section className="runtime-camera" aria-label={`${device.id} camera`} data-device={device.id}>
    <div className="section-heading"><h2><Camera size={17}/>{device.label ?? device.id}</h2><span className="meta">OV2640 on I2S0 DMA</span></div>
    <div className="runtime-device-tools"><label>Image source <select aria-label={`${device.id} image source`} value={source} disabled={disabled} onChange={event => select(event.target.value as Source)}>
      <option value="off">Off</option><option value="pattern">Test pattern</option><option value="webcam">Webcam</option></select></label></div>
    {error && <div className="field-error" role="alert">{error}</div>}
    <div className="camera-view">
      <canvas ref={canvas} className="camera-preview" aria-label={`${device.id} frame sent to the sensor`} hidden={source === 'off' || !ready}/>
      <video ref={video} muted playsInline hidden/>
      <dl className="camera-stats">
        <dt>Status</dt><dd data-camera="status">{status}</dd>
        <dt>Sensor output</dt><dd data-camera="sensor">{ready ? `${format?.toUpperCase()} ${width}x${height}` : '--'}</dd>
        <dt>Frames sent</dt><dd>{sent.count}{sent.count > 0 && ` (${sent.bytes} bytes)`}</dd>
        <dt>Frames delivered</dt><dd data-camera="delivered">{camera?.framesDelivered ?? 0}</dd>
        <dt title="The sensor sends frames all the time. A frame reaches memory only while the firmware has DMA running, as on real hardware.">Frames missed</dt><dd>{camera?.framesMissed ?? 0}</dd>
        <dt>DMA</dt><dd data-camera="dma">{camera ? `${camera.dma.bytes} bytes, ${camera.dma.eofInterrupts} EOF${camera.dma.descriptorErrors ? `, ${camera.dma.descriptorErrors} descriptor errors` : ''}` : '--'}</dd>
      </dl>
    </div>
    {camera?.error && <p className="meta">{camera.error}</p>}
  </section>;
}
