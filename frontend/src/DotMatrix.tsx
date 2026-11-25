import { matrixDuty, matrixPixel, type Max7219State } from '../../shared/dot-matrix';
import type { Peripheral } from '../../shared/protocol';

type MatrixDevice = Extract<Peripheral, { kind: 'max7219' }>;
const colors = { red: '#e84f4f', green: '#32bd75', blue: '#368be6', amber: '#e6b137', white: '#e6eeee' };

export function DotMatrix({ device, state }: { device: MatrixDevice; state?: Max7219State | null }) {
  const observed = state?.devices.find(entry => entry.id === device.id);
  return <div className="dot-matrix-display">
    <div className="dot-matrix-chain" role="group" aria-label={`${device.label} modules`}>
      {Array.from({ length: device.length }, (_, index) => {
        const module = observed?.modules[index];
        const status = !module ? 'unavailable' : module.displayTest ? 'display test' : module.shutdown ? 'shutdown' : 'active';
        return <div className="dot-matrix-module" key={index} data-module={index}>
          <svg viewBox="0 0 100 100" role="img" aria-label={`${device.label} module ${index} ${status}`} data-status={status}>
            <rect width="100" height="100" rx="5" fill="#171d1b" />
            {Array.from({ length: 64 }, (_, pixel) => {
              const row = Math.floor(pixel / 8), column = pixel % 8;
              const on = matrixPixel(module, row, column);
              return <circle key={pixel} cx={8 + column * 12} cy={8 + row * 12} r="4"
                data-row={row} data-column={column} data-on={module ? String(on) : 'unavailable'}
                fill={on ? colors[device.color] : '#333b37'}
                fillOpacity={on && module ? Math.min(1, matrixDuty(module) * 256 / 31) : 1} />;
            })}
          </svg>
          <span className="dot-matrix-status">{index}: {status}</span>
          {module && <span className="dot-matrix-registers" title={`Stored intensity ${module.intensity}, scan limit ${module.scanLimit}, decode mode ${module.decodeMode}`}>
            Intensity {module.displayTest ? 15 : module.intensity}/15 · Scan {module.displayTest ? 8 : module.scanLimit + 1}/8 · Decode 0x{module.decodeMode.toString(16).padStart(2, '0')}
          </span>}
        </div>;
      })}
    </div>
    <span className="dot-matrix-status">{observed ? `${observed.latches} LOAD latches` : 'QEMU model state unavailable'}</span>
  </div>;
}
