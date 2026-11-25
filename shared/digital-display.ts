import type { GpioState } from './protocol.ts';

export function digitalChannel(state: GpioState | null | undefined, pin: number, activeLow: boolean) {
  const observed = state?.pins.find(value => value.pin === pin);
  if (!observed) return { pin, status: 'unavailable' as const, on: false };
  if (!observed.outputEnabled) return { pin, status: 'input' as const, on: false };
  return { pin, status: observed.level ? 'high' as const : 'low' as const, on: activeLow ? observed.level === 0 : observed.level === 1 };
}

export function rgbDisplay(state: GpioState | null | undefined, pins: readonly number[], activeLow: boolean) {
  const channels = pins.map(pin => digitalChannel(state, pin, activeLow));
  const outputs = channels.filter(channel => channel.status === 'high' || channel.status === 'low').length;
  return { channels, status: outputs === 3 ? 'output' as const : outputs ? 'partial' as const : channels.some(channel => channel.status === 'unavailable') ? 'unavailable' as const : 'input' as const };
}
