import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

test('ESP-IDF reads the TMP105 over guest I2C after host QOM input', { timeout: 30000 }, async () => {
    const root = resolve(import.meta.dirname, '..');
    const socketPath = resolve(root, '.run/gate.qmp');
    mkdirSync(resolve(root, '.run'), { recursive: true });
    if (existsSync(socketPath)) unlinkSync(socketPath);
    const emulator = spawn(resolve(root, '.cache/qemu/build/qemu-system-xtensa'), [
        '-machine', 'esp32', '-display', 'none', '-monitor', 'none',
        '-serial', 'stdio', '-qmp', `unix:${socketPath},server=on,wait=off`,
        '-drive', `file=${root}/firmware/build/qemu_flash.bin,if=mtd,format=raw`,
        '-L', resolve(root, '.cache/qemu/pc-bios'),
    ], { env: { ...process.env, ESPEMU_QEMU_CIRCUIT: resolve(root, 'tests/fixtures/demo-circuit.json') } });
    let output = '';
    const samples = [];
    emulator.stdout.on('data', chunk => {
        output += chunk;
        const matches = output.matchAll(/ESP_EMU (\{[^\r\n]+\})\r?\n/g);
        for (const match of matches) {
            const sample = JSON.parse(match[1]);
            if (!samples.some(entry => entry.seq === sample.seq)) samples.push(sample);
        }
    });
    emulator.stderr.on('data', chunk => { output += chunk; });
    const waitFor = async predicate => {
        const deadline = Date.now() + 12000;
        while (!predicate()) {
            assert.equal(emulator.exitCode, null, output);
            assert.ok(Date.now() < deadline, `Timed out: ${output.slice(-4000)}`);
            await new Promise(done => setTimeout(done, 10));
        }
    };
    let socket;
    try {
        await waitFor(() => existsSync(socketPath));
        socket = createConnection(socketPath);
        let buffer = '';
        let counter = 0;
        const pending = new Map();
        socket.on('data', chunk => {
            buffer += chunk;
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) {
                const message = JSON.parse(buffer.slice(0, end));
                buffer = buffer.slice(end + 1);
                if (message.id && pending.has(message.id)) {
                    pending.get(message.id)(message);
                    pending.delete(message.id);
                }
            }
        });
        await new Promise((done, reject) => { socket.once('connect', done); socket.once('error', reject); });
        const command = async (execute, argumentsValue = {}) => {
            const id = ++counter;
            const response = new Promise(done => pending.set(id, done));
            socket.write(JSON.stringify({ execute, arguments: argumentsValue, id }) + '\n');
            const result = await response;
            assert.ok(!result.error, JSON.stringify(result));
            return result.return;
        };
        await command('qmp_capabilities');
        const findTemperature = async path => {
            for (const property of await command('qom-list', { path })) {
                if (property.name === 'temperature') return path;
                if (property.type.startsWith('child<')) {
                    const found = await findTemperature(`${path}/${property.name}`);
                    if (found) return found;
                }
            }
        };
        const devicePath = await findTemperature('/machine');
        assert.ok(devicePath, 'TMP105 QOM object must be discoverable');
        await waitFor(() => samples.some(sample => sample.tmp105.error === 0));
        const before = samples.at(-1);
        await command('qom-set', { path: devicePath, property: 'temperature', value: 37500 });
        await waitFor(() => samples.some(sample => sample.seq > before.seq && sample.tmp105.temperatureC === 37.5));
        console.log(JSON.stringify({ devicePath, before, after: samples.at(-1) }));
        const initialState = JSON.parse(await command('qom-get', { path: '/machine/soc', property: 'espemu-state' }));
        const inputs = initialState.inputs;
        const rejected = structuredClone(inputs);
        rejected.bme280.pressurePa = 0;
        await assert.rejects(command('qom-set', { path: '/machine/soc', property: 'espemu-inputs', value: JSON.stringify(rejected) }));
        const unchanged = JSON.parse(await command('qom-get', { path: '/machine/soc', property: 'espemu-state' }));
        assert.deepEqual(unchanged.inputs, inputs, 'Invalid snapshots must not partially mutate sensors');
        inputs.tmp105.temperatureMc = 42500;
        inputs.bh1750.luxMilli = 640000;
        inputs.bme280.temperatureMc = 31000;
        inputs.bme280.pressurePa = 98765;
        inputs.bme280.humidityMilli = 67000;
        await command('qom-set', { path: '/machine/soc', property: 'espemu-inputs', value: JSON.stringify(inputs) });
        await waitFor(() => samples.some(sample => sample.tmp105.temperatureC === 42.5));
        await waitFor(() => samples.some(sample => sample.bh1750?.lux === 640 && sample.bh1750.error === 0));
        await waitFor(() => samples.some(sample => sample.bme280?.error === 0 &&
            Math.abs(sample.bme280.temperatureC - 31) < 0.02 &&
            Math.abs(sample.bme280.pressurePa - 98765) < 2 &&
            Math.abs(sample.bme280.humidityPct - 67) < 0.05));
        console.log('Full catalog after input:', JSON.stringify(samples.at(-1)));
        const trace = JSON.parse(await command('qom-get', { path: '/machine/soc/i2c0', property: 'espemu-trace' }));
        assert.ok(trace.events.some(event => event.address === 0x48 && event.read && event.length > 0 && event.status === 'ok'));
        assert.ok(trace.events.length <= 128);
        await command('stop');
        const paused = JSON.parse(await command('qom-get', { path: '/machine/soc', property: 'espemu-state' }));
        await new Promise(done => setTimeout(done, 80));
        const stillPaused = JSON.parse(await command('qom-get', { path: '/machine/soc', property: 'espemu-state' }));
        assert.equal(stillPaused.virtualMs, paused.virtualMs, 'Conversions use the paused QEMU virtual clock');
        await command('cont');
        for (const [deviceId, address] of [['tmp105', 0x48], ['bh1750', 0x23], ['bme280', 0x76]]) {
            const previous = samples.at(-1).seq;
            inputs[deviceId].connected = false;
            await command('qom-set', { path: '/machine/soc', property: 'espemu-inputs', value: JSON.stringify(inputs) });
            await waitFor(() => samples.some(sample => sample.seq > previous && sample[deviceId]?.error !== 0 && Object.entries(sample[deviceId]).filter(([key]) => key !== 'error').every(([, value]) => value === null)));
            const faultTrace = JSON.parse(await command('qom-get', { path: '/machine/soc/i2c0', property: 'espemu-trace' }));
            assert.ok(faultTrace.events.some(event => event.address === address && event.status === 'nack'));
            inputs[deviceId].connected = true;
            const recovery = samples.at(-1).seq;
            await command('qom-set', { path: '/machine/soc', property: 'espemu-inputs', value: JSON.stringify(inputs) });
            await waitFor(() => samples.some(sample => sample.seq > recovery && sample[deviceId]?.error === 0));
            const validSequence = samples.at(-1).seq;
            inputs[deviceId].invalid = true;
            await command('qom-set', { path: '/machine/soc', property: 'espemu-inputs', value: JSON.stringify(inputs) });
            await waitFor(() => samples.some(sample => sample.seq > validSequence && sample[deviceId]?.error === 264));
            inputs[deviceId].invalid = false;
            const invalidSequence = samples.at(-1).seq;
            await command('qom-set', { path: '/machine/soc', property: 'espemu-inputs', value: JSON.stringify(inputs) });
            await waitFor(() => samples.some(sample => sample.seq > invalidSequence && sample[deviceId]?.error === 0));
            console.log(`${deviceId}: guest NACK, invalid reading, and recovery passed`);
        }
        await command('stop');
        samples.length = 0;
        output = '';
        await command('system_reset');
        await command('cont');
        await waitFor(() => samples.some(sample => sample.seq === 0 && sample.tmp105.error === 0 && sample.bh1750?.error === 0 && sample.bme280?.error === 0));
        assert.equal(samples.find(sample => sample.seq === 0).tmp105.temperatureC, 42.5);
        const resetTrace = JSON.parse(await command('qom-get', { path: '/machine/soc/i2c0', property: 'espemu-trace' }));
        assert.equal(resetTrace.events[0].seq, 1);
        console.log('Full-catalog reset preserved physical inputs and restarted driver/trace state');
    } finally {
        socket?.destroy();
        emulator.kill('SIGTERM');
        if (emulator.exitCode === null) await new Promise(done => emulator.once('exit', done));
    }
});
