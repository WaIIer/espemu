import { Monitor } from 'lucide-react';
import { LcdStateSchema, lcdCells } from '../../shared/lcd';
import type { CircuitDevice } from '../../shared/registry';
import type { ModelState } from '../../shared/runtime';

function Glyph({ rows }: { rows: number[] }) {
  return <svg className="lcd-glyph" viewBox="0 0 5 8" aria-hidden="true">{rows.flatMap((bits, row) => Array.from({ length: 5 }, (_, column) =>
    bits & (0x10 >> column) ? <rect key={`${row}:${column}`} x={column + .06} y={row + .06} width=".88" height=".88"/> : null))}</svg>;
}

export function LcdPanel({ device, model }: { device: Extract<CircuitDevice, { type: 'hd44780' }>; model: ModelState | undefined }) {
  const [columns, rows] = device.size.split('x').map(Number);
  const parsed = LcdStateSchema.safeParse(model);
  const state = parsed.success ? parsed.data : null;
  const cells = state ? lcdCells(state, columns, rows) : [];
  const text = cells.map(row => row.map(cell => cell.character ?? `[${cell.code}]`).join('')).join('\n');
  return <section className="runtime-lcd" aria-label={`${device.id} display`} data-device={device.id}>
    <div className="section-heading"><h2><Monitor size={17}/>{device.label ?? device.id}</h2><span className="meta">HD44780 {device.size} / 0x{device.address.toString(16)}</span></div>
    <div className={`lcd-bezel${state?.backlight ? ' lcd-lit' : ''}`}>
      <div className="lcd-screen" role="img" aria-label={state?.displayOn ? text : 'Display off'} data-lcd-text={state?.displayOn ? text : ''} style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {(state ? cells : Array.from({ length: rows }, () => Array.from({ length: columns }, () => null))).flatMap((row, rowIndex) => row.map((cell, column) =>
          <span key={`${rowIndex}:${column}`} className={`lcd-cell${state?.displayOn && cell?.cursor && state.blink ? ' lcd-blink' : ''}`}>
            {state?.displayOn && cell ? cell.glyph ? <Glyph rows={cell.glyph}/> : cell.character : ''}
            {state?.displayOn && cell?.cursor && state.cursor && <span className="lcd-underline"/>}
          </span>))}
      </div>
    </div>
    <p className="meta">{!state ? 'Waiting for QEMU' : state.status === 'disconnected' ? 'Disconnected: transfers NACK' :
      `${state.displayOn ? 'Display on' : 'Display off'} · backlight ${state.backlight ? 'on' : 'off'} · ${state.eightBit ? '8-bit' : '4-bit'} · ${state.instructions} instructions, ${state.dataWrites} characters`}</p>
    {!!state?.ignoredWhileBusy && <p className="field-error" role="status">{state.ignoredWhileBusy} transfers arrived while the controller was busy and were ignored. Wait 1.52 ms after clear/home.</p>}
  </section>;
}
