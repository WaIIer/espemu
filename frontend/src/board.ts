import type { Topology } from './useSession';

export function createBoardBitmap(topology: Topology): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1000;
  canvas.height = 280;
  const context = canvas.getContext('2d');
  if (!context) return '';
  context.fillStyle = '#f5f7f6';
  context.fillRect(0, 0, 1000, 280);
  context.strokeStyle = '#dfe6e3';
  context.lineWidth = 1;
  for (let position = 12; position < 1000; position += 20) { context.beginPath(); context.moveTo(position, 0); context.lineTo(position, 280); context.stroke(); }
  for (let position = 10; position < 280; position += 20) { context.beginPath(); context.moveTo(0, position); context.lineTo(1000, position); context.stroke(); }
  context.fillStyle = '#156b56';
  context.fillRect(24, 34, 236, 211);
  context.fillStyle = '#bbc7c3';
  context.fillRect(73, 64, 135, 138);
  context.fillStyle = '#273432';
  context.fillRect(80, 112, 121, 83);
  context.fillStyle = '#eff6f2';
  context.font = 'bold 24px monospace';
  context.fillText('ESP32', 102, 158);
  context.font = '12px monospace';
  context.fillText('I2C0 MASTER', 97, 178);
  context.strokeStyle = '#5e7169';
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(92, 98); context.lineTo(92, 78); context.lineTo(112, 78); context.lineTo(112, 98); context.lineTo(132, 98); context.lineTo(132, 78); context.lineTo(152, 78); context.lineTo(152, 98); context.lineTo(188, 98);
  context.stroke();
  context.fillStyle = '#d4bc71';
  for (let pin = 0; pin < 9; pin += 1) { context.fillRect(32, 52 + pin * 19, 10, 10); context.fillRect(242, 52 + pin * 19, 10, 10); }
  context.fillStyle = '#e7f2eb';
  context.font = '12px monospace';
  context.fillText(`SDA ${topology.bus.sda}`, 166, 219);
  context.fillText(`SCL ${topology.bus.scl}`, 166, 235);
  context.strokeStyle = '#168574';
  context.lineWidth = 3;
  context.beginPath(); context.moveTo(260, 214); context.lineTo(300, 214); context.lineTo(300, 255); context.lineTo(925, 255); context.stroke();
  context.strokeStyle = '#657b75';
  context.beginPath(); context.moveTo(260, 231); context.lineTo(280, 231); context.lineTo(280, 270); context.lineTo(950, 270); context.stroke();
  topology.devices.slice(0, 3).forEach((device, index) => {
    const left = 365 + index * 210;
    context.fillStyle = '#e4eee9'; context.fillRect(left, 38, 168, 165);
    context.strokeStyle = '#8ea99e'; context.lineWidth = 1; context.strokeRect(left, 38, 168, 165);
    context.fillStyle = '#32413c'; context.fillRect(left + 49, 68, 70, 60);
    context.fillStyle = '#d4bc71';
    for (let pin = 0; pin < 4; pin += 1) { context.fillRect(left + 40, 75 + pin * 12, 9, 5); context.fillRect(left + 119, 75 + pin * 12, 9, 5); }
    context.fillStyle = '#25362f'; context.font = 'bold 18px monospace'; context.fillText(device.name, left + 22, 157);
    context.font = '14px monospace'; context.fillText(`0x${device.address.toString(16).padStart(2, '0')}`, left + 22, 180); context.fillText(`${device.conversionMs} ms`, left + 93, 180);
    context.strokeStyle = '#168574'; context.lineWidth = 3; context.beginPath(); context.moveTo(left + 70, 203); context.lineTo(left + 70, 255); context.stroke();
    context.strokeStyle = '#657b75'; context.beginPath(); context.moveTo(left + 96, 203); context.lineTo(left + 96, 270); context.stroke();
  });
  return canvas.toDataURL('image/png');
}
