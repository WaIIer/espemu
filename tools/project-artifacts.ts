import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { loadProject } from '../server/project.ts';
import { PERIPHERAL_REGISTRY, isCamera, isSensor, isSpeaker, peripheralFamily, wiredPins, type CircuitDevice } from '../shared/registry.ts';
import type { ProjectManifest } from '../shared/manifest.ts';
import { z } from 'zod';
import { deviceMacroName, devicePinsHeader } from '../shared/device-pins.ts';
export { deviceMacroName, devicePinsHeader } from '../shared/device-pins.ts';

const frameworkRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const code = (text: string, language = 'c') => `\n\`\`\`${language}\n${text.trim()}\n\`\`\`\n`;
const label = (text: string) => text.replace(/[\r\n]/g, ' ').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/[<>`]/g, '');
const usesDeviceSdk = (manifest: ProjectManifest) => manifest.devices.some(device=>isSensor(device)||isCamera(device)||isSpeaker(device)||device.type==='ws2812b'||device.type==='max7219');
export const ESP32_CAMERA_VERSION = '2.1.7';
const cameraWiring = (signals: Record<string,number>) => Object.entries(signals).filter(([,pin])=>pin>=0).map(([signal,pin])=>`${signal.toUpperCase()}: GPIO${pin}`).join(', ');
const sdkHook = 'include("${CMAKE_CURRENT_LIST_DIR}/.espemu-device-sdk.cmake" OPTIONAL)';

export function blockDiagram(manifest: ProjectManifest): string {
  const lines = ['flowchart LR', '  esp["ESP32 / ordinary ESP-IDF firmware"]'];
  for (const [index,bus] of manifest.buses.entries()) lines.push(`  bus${index}["${label(bus.id)} / I2C${bus.controller}<br/>SDA ${bus.sda}, SCL ${bus.scl}"]`, `  esp <--> bus${index}`);
  for (const [index,device] of manifest.devices.entries()) {
    const node = `device${index}`;
    lines.push(`  ${node}["${label(device.label ?? device.id)} / ${label(device.type)}"]`);
    if (isSensor(device)) lines.push(`  bus${manifest.buses.findIndex(bus=>bus.id===device.bus)} <-->|"0x${device.address.toString(16)}"| ${node}`);
    else if (isSpeaker(device)) lines.push(`  esp -->|"I2S DIN ${device.din}, BCLK ${device.bclk}, LRCLK ${device.lrclk}"| ${node}`);
    else if (isCamera(device)) lines.push(`  esp <-->|"SCCB GPIO${device.signals.sda}/${device.signals.scl}"| ${node}`, `  ${node} -->|"D0-D7, VSYNC GPIO${device.signals.vsync} / I2S0 DMA"| esp`);
    else if (device.type === 'max7219') wiredPins(device).forEach((pin,signal)=>lines.push(`  esp -->|"GPIO${pin} / ${['DIN','CLK','LOAD'][signal]}"| ${node}`));
    else if (device.type === 'rgb') device.pins.forEach((pin,channel)=>lines.push(`  esp -->|"GPIO${pin} / ${['R','G','B'][channel]}"| ${node}`));
    else lines.push(`  ${['button','switch'].includes(peripheralFamily(device.type)) ? `${node} -->|"GPIO${device.pin}"| esp` : `esp -->|"GPIO${device.pin}"| ${node}`}`);
  }
  return lines.join('\n');
}

function usage(device: CircuitDevice): string {
  const id = `device_${device.id.replace(/[^A-Za-z0-9_]/g,'_')}`;
  const name = deviceMacroName(device.id);
  if(device.type==='max7219')return `Initialize once (no decode, eight rows, intensity 8, display enabled):\n${code(`espemu_max7219_t ${id};\nESP_ERROR_CHECK(espemu_max7219_init(&${id}, ${name}_DIN_PIN, ${name}_CLK_PIN, ${name}_LOAD_PIN, ${name}_MODULE_COUNT));`)}\nWrite an 8x8 image to module 0, nearest DIN:\n${code(`const uint8_t rows[8] = {0x18, 0x3c, 0x7e, 0xff, 0xff, 0x7e, 0x3c, 0x18};\nESP_ERROR_CHECK(espemu_max7219_set_rows(&${id}, 0, rows));\nESP_ERROR_CHECK(espemu_max7219_write(&${id}, 0, 0x0a, 15));`)}\nRows map to DIG0-DIG7, columns left-to-right to D7-D0 (DP,A,B,C,D,E,F,G). Module indexes follow DIN -> DOUT, 0-${device.length-1}. Raw register writes support intensity (0x0a), scan limit (0x0b), shutdown (0x0c) and display test (0x0f). GPIO bit-banging uses the real MAX7219 16-bit, MSB-first protocol and NO-OP packets for other modules; no UART shim. Hardware SPI routing and electrical timing/current are not emulated. Calls sharing a chain must be serialized by the application.\n`;
  if(isSpeaker(device))return `Initialize once with the sample rate of your audio (16-bit stereo standard I2S on I2S1, leaving I2S0 to a camera):\n${code(`i2s_chan_handle_t ${id};\nESP_ERROR_CHECK(espemu_max98357a_init(&${id}, ${name}_BCLK_PIN, ${name}_LRCLK_PIN, ${name}_DIN_PIN, 16000));`)}\nPlay a 440 Hz tone for half a second:\n${code(`ESP_ERROR_CHECK(espemu_max98357a_tone(${id}, 16000, 440, 500, 8000));`)}\nStream your own samples with i2s_channel_write(${id}, frames, bytes, &written, portMAX_DELAY): interleaved int16 left/right frames. Your own ESP-IDF i2s_std code also works when it routes DOUT/BCLK/WS to these pins and uses the default PLL_D2 clock in Philips/MSB standard mode. The workbench plays what the emulated I2S DMA actually clocks out, mixed (L+R)/2 like the amplifier's default SD_MODE. Not emulated: the APLL clock source, PDM/TDM modes, the amplifier's gain pin, SD_MODE shutdown and analog output.\n`;
  if(isCamera(device))return `Initialize once. The pinned esp32-camera driver probes the sensor over SCCB, starts XCLK and allocates DMA frame buffers:\n${code(`camera_config_t ${id}_config = ${name}_CAMERA_CONFIG(PIXFORMAT_JPEG, FRAMESIZE_QVGA);\nESP_ERROR_CHECK(esp_camera_init(&${id}_config));`)}\nCapture a frame and return its buffer:\n${code(`camera_fb_t *frame = esp_camera_fb_get();\nif (frame) {\n    ESP_LOGI("${device.id}", "%ux%u, %u bytes", frame->width, frame->height, (unsigned)frame->len);\n    esp_camera_fb_return(frame);\n}`)}\nPick a source in the workbench camera panel (webcam or test pattern). The browser scales each picture to the size and format the firmware configured (JPEG, RGB565 or YUV422), and the emulated OV2640 streams it through the real I2S0 camera DMA descriptors after VSYNC. Use FRAMESIZE_QVGA or smaller for raw formats with DRAM frame buffers. Not emulated: PSRAM, image tuning registers (exposure, gain, effects), pixel clock timing and the sensor's own JPEG encoder; JPEG compression happens in the browser.\n`;
  if(device.type==='ws2812b')return `Initialize once:\n${code(`led_strip_handle_t ${id};\nESP_ERROR_CHECK(espemu_ws2812_init(&${id}, ${name}_PIN, ${name}_LED_COUNT));`)}\nSet a pixel and display it:\n${code(`ESP_ERROR_CHECK(led_strip_set_pixel(${id}, 0, 255, 0, 0));\nESP_ERROR_CHECK(led_strip_refresh(${id}));`)}\nIndexes: 0-${device.length-1}; RGB: 0-255. Turn all pixels off with led_strip_clear(${id}). RMT TX only; bit-banged GPIO, DMA, RX, carrier and loops are unsupported.\n`;
  if (!isSensor(device)) {
    if (device.type === 'rgb') return `Initialize the three outputs, then set the colors:\n${code(['RED','GREEN','BLUE'].map(channel=>`ESP_ERROR_CHECK(gpio_set_direction(${name}_${channel}_PIN, GPIO_MODE_OUTPUT));`).join('\n')+'\n'+['RED','GREEN','BLUE'].map(channel=>`ESP_ERROR_CHECK(gpio_set_level(${name}_${channel}_PIN, ${name}_ACTIVE_LEVEL));`).join('\n'))}\nUse ${name}_INACTIVE_LEVEL to turn a channel off. Digital on/off only, not PWM brightness.\n`;
    if (peripheralFamily(device.type) === 'led') return `Initialize and activate:\n${code(`ESP_ERROR_CHECK(gpio_set_direction(${name}_PIN, GPIO_MODE_OUTPUT));\nESP_ERROR_CHECK(gpio_set_level(${name}_PIN, ${name}_ACTIVE_LEVEL));`)}\nDeactivate with gpio_set_level(${name}_PIN, ${name}_INACTIVE_LEVEL). This is a digital output; PWM, timing, electrical loads and power characteristics are not modeled.\n`;
    if (device.type === 'probe') return `Read the observed pin without changing its configuration:\n${code(`int ${id}_level = gpio_get_level(${name}_PIN);`)}\nThe pin's input buffer must be enabled. For output readback, initialize that output with GPIO_MODE_INPUT_OUTPUT.\n`;
    const definition = PERIPHERAL_REGISTRY[device.type];
    const drive = 'drive' in definition ? definition.drive : 'contact';
    const pull = device.pin < 34 && drive !== 'push-pull' ? `\nESP_ERROR_CHECK(gpio_set_pull_mode(${name}_PIN, ${drive==='open-collector'||device.activeLow?'GPIO_PULLUP_ONLY':'GPIO_PULLDOWN_ONLY'}));` : '';
    const note = drive==='push-pull' ? 'This module drives both HIGH and LOW; no input pull resistor is needed.' : device.pin>=34 ? ('pullUp' in device && device.pullUp ? 'The declared pull-up ("pullUp": true) holds the released input HIGH; GPIO34-39 have no internal pulls.' : `GPIO34-39 have no internal pulls, so a released input floats. Declare "pullUp": true on this device for a module or external ${drive==='open-collector'||device.activeLow?'pull-up':'pull-down'} resistor.`) : 'The pull defines a released output/contact level. Omit the pull call if the module already supplies that resistor.';
    return `Initialize once, then read the ${device.type}:\n${code(`ESP_ERROR_CHECK(gpio_set_direction(${name}_PIN, GPIO_MODE_INPUT));${pull}\nbool ${id}_active = gpio_get_level(${name}_PIN) == ${name}_ACTIVE_LEVEL;`)}\n${note}\n`;
  }
  if(device.type==='hd44780')return `Initialize once (4-bit mode, display on, cursor off, backlight on):\n${code(`espemu_hd44780_t ${id};\nESP_ERROR_CHECK(espemu_hd44780_init(&${id}, ${name}_I2C_PORT, ${name}_I2C_ADDRESS, ${name}_COLUMNS, ${name}_ROWS));`)}\nWrite text:\n${code(`ESP_ERROR_CHECK(espemu_hd44780_set_cursor(&${id}, 0, 0));\nESP_ERROR_CHECK(espemu_hd44780_print(&${id}, "Hello"));\nESP_ERROR_CHECK(espemu_hd44780_printf(&${id}, 0, 1, "T=%.1f%cC", 21.5, 0xdf));`)}\nAlso: espemu_hd44780_clear, espemu_hd44780_backlight(&${id}, false), espemu_hd44780_display(&${id}, on, cursor, blink), and custom glyphs with espemu_hd44780_create_char(&${id}, slot, rows) (slot 0-7, 5 bits per row; this moves the cursor to 0,0) shown with espemu_hd44780_write_char(&${id}, slot). Text uses the HD44780 A00 character ROM: ASCII except 0x5C (yen), 0x7E/0x7F arrows, 0xDF degree. The packaged driver drives the real PCF8574 backpack protocol (P0 RS, P1 RW, P2 E, P3 backlight, P4-P7 D4-D7) and waits the datasheet execution times; instructions sent while the controller is busy are ignored, as on hardware. Contrast, power and LCD timing beyond the busy flag are not modeled.\n`;
  const initialization=code(`espemu_${device.type}_t ${id};\nESP_ERROR_CHECK(espemu_${device.type}_init(&${id}, ${name}_I2C_PORT, ${name}_I2C_ADDRESS));`);
  if(device.type==='tmp105'||device.type==='bh1750'){
    const quantity=device.type==='tmp105'?'temperature_c':'lux';
    return `Initialize once:\n${initialization}\nRead:\n${code(`float ${id}_${quantity};\nESP_ERROR_CHECK(espemu_${device.type}_read(&${id}, &${id}_${quantity}));\nESP_LOGI("${device.id}", "${quantity}=%.2f", ${id}_${quantity});`)}\n`;
  }
  const fields=device.type==='bme280'?['temperature_c','pressure_pa','humidity_pct']:device.type==='sht3x'?['temperature_c','humidity_pct']:['gyro_x_dps','gyro_y_dps','gyro_z_dps','accel_x_g','accel_y_g','accel_z_g'];
  return `Initialize once:\n${initialization}\nRead:\n${code(`espemu_${device.type}_reading_t ${id}_reading;\nESP_ERROR_CHECK(espemu_${device.type}_read(&${id}, &${id}_reading));\nESP_LOGI("${device.id}", "${fields.slice(0,3).map(field=>`${field}=%.2f`).join(' ')}",\n    ${fields.slice(0,3).map(field=>`${id}_reading.${field}`).join(', ')});`)}\nValues: ${fields.join(', ')}. ${device.type==='bme280'?'Temperature is C, pressure is Pa, humidity is %RH.':device.type==='sht3x'?'Temperature is C and humidity is %RH from one CRC-checked high-repeatability single-shot measurement; a corrupt word returns ESP_ERR_INVALID_CRC.':'Rotation is deg/s; acceleration is g. A stationary tilted sensor has gravity acceleration but zero rotation.'}\n`;
}

function regressionExample(manifest: ProjectManifest): string {
  const sensor=manifest.devices.find(isSensor),output=manifest.devices.find(device=>peripheralFamily(device.type)==='led'),button=manifest.devices.find(device=>peripheralFamily(device.type)==='button');
  const channel=sensor?Object.entries(PERIPHERAL_REGISTRY[sensor.type].channels)[0]:undefined;
  const body=[
    ...(sensor&&channel?[`await project.input('${sensor.id}', { ${channel[0]}: ${Math.min(channel[1].maximum,channel[1].initial+1)} });`,`// QEMU converts the physical input; your firmware then reads it over I2C.`,`await project.waitFor(state => Math.abs((state.deviceStates['${sensor.id}']?.channels.${channel[0]} ?? NaN) - ${Math.min(channel[1].maximum,channel[1].initial+1)}) < ${Math.max(channel[1].step,0.1)});`]:[]),
    ...(button?[`await project.press('${button.id}');`]:[]),
    ...(output?[`await project.waitFor(state => project.isOn('${output.id}', state) !== null);`]:[]),
  ];
  return `// test/smoke.test.mjs\nimport { test } from 'node:test';\nimport { startProject } from 'espemu/regression';\n\ntest('firmware reacts to the circuit', { timeout: 60000 }, async () => {\n  const project = await startProject();\n  try {\n${(body.length?body:['await project.waitFor(state => state.phase === \'running\');']).map(line=>`    ${line}`).join('\n')}\n  } finally {\n    await project.stop();\n  }\n});`;
}

export function projectReadme(directory: string, manifest: ProjectManifest, _root = frameworkRoot): string {
  const lines = [`# ${basename(directory)}`, '', 'Generated from the project circuit manifest. These examples are documentation, not code automatically inserted into your application.',
    '', '## Project Commands', code('make help\nmake add_component\nDEVICE=bme280 make add_component\nmake build\nmake run\nmake web\nmake test\nmake clean\nmake validate\nmake docs', 'sh'),
    'make run builds this firmware and starts QEMU/web; make web reuses its built image. DEVICE=TYPE or DEVICE=\'{"type":"led","id":"fan","pin":25}\' adds a device without prompts. make test builds the firmware and runs the regression tests in test/. clean removes only build output. No special UART telemetry is needed for GPIO/model visualization.',
    '', '## System Block Diagram', code(blockDiagram(manifest), 'mermaid'), 'Logical connections only; this is not an electrical schematic.',
    '', '## Editor Setup', 'Open this folder in VS Code, either in the generated Dev Container or from an activated local ESP-IDF environment. Run the ESP-IDF: Prepare IntelliSense task to generate build/compile_commands.json without building firmware. IntelliSense uses the actual compiler, flags and headers from that database.',
    '', '## Circuit', '| Instance | Model | Wiring |', '| --- | --- | --- |',
    ...manifest.devices.map(device=>`| ${device.id} | ${device.type} | ${isSensor(device) ? `${device.bus} / 0x${device.address.toString(16)}` : isSpeaker(device) ? `DIN: GPIO${device.din}, BCLK: GPIO${device.bclk}, LRCLK: GPIO${device.lrclk}` : isCamera(device) ? cameraWiring(device.signals) : device.type==='max7219' ? wiredPins(device).map((pin,index)=>`${['DIN','CLK','LOAD'][index]}: GPIO${pin}`).join(', ') : device.type==='rgb' ? device.pins.map((pin,index)=>`${['R','G','B'][index]}: GPIO${pin}`).join(', ') : `GPIO${device.pin}`} |`),
    '', '## Shared Initialization', 'Include device_pins.h. The device SDK and only the drivers your circuit needs (the Bosch BME280 driver, the pinned WS2812 LED-strip library) are installed and linked automatically for configured sensors/strips/matrices. The header includes GPIO, FreeRTOS, logging and device APIs. No application callbacks or manual dependency edits are needed.',
    code('#include "device_pins.h"'),
  ];
  if(manifest.buses.length) {
    const bus=manifest.buses[0];
    const name=deviceMacroName(bus.id);
    lines.push('Initialize the shared bus once:',code(`ESP_ERROR_CHECK(espemu_i2c_init(${name}_I2C_PORT, ${name}_SDA_PIN, ${name}_SCL_PIN, ${bus.frequencyHz}));`));
  }
  for (const device of manifest.devices) lines.push(`\n## ${device.id} / ${PERIPHERAL_REGISTRY[device.type].label}\n`,usage(device));
  if (usesDeviceSdk(manifest)) lines.push('## Application Telemetry', 'Optional: report firmware decisions to the workbench Application tab and to regression tests. Missing readings are sent as null.',
    code('espemu_telemetry_t packet;\nespemu_telemetry_begin(&packet);\nespemu_telemetry_value(&packet, "temperature", 24.5, "C");\nespemu_telemetry_value(&packet, "fan_on", 1, "");\nespemu_telemetry_missing(&packet, "light", "lx");\nESP_ERROR_CHECK(espemu_telemetry_send(&packet));'),
    'Names may use letters, digits and _.-:/%; at most 64 channels and 1 KiB per packet. espemu_telemetry_send returns ESP_ERR_INVALID_SIZE instead of printing a truncated packet.', '');
  lines.push('## Regression Tests', 'Put Node tests in test/ and run make test. It builds this firmware, then each test starts its own workbench on a free loopback port. Use device ids rather than GPIO numbers:',
    code(regressionExample(manifest), 'js'), 'isOn() reads the real GPIO pad (null until firmware enables the output); channel() reads optional application telemetry. Keep physical inputs, QEMU model state and firmware decisions as separate assertions.', '');
  lines.push('## Physical Inputs and Scenarios',code(JSON.stringify({inputs:manifest.inputs,gpioInputs:manifest.gpioInputs,scenarios:manifest.scenarios},null,2),'json'),
    'Inputs are the simulated environment; QEMU model state is the converted/register state. Optional application packets are separate observations. Bus disconnection produces NACKs; invalid flags inject invalid readings.',
    '', '## Regeneration and Limits', 'make docs refreshes unchanged generated documentation/editor files. User-edited files are preserved. GPIO output enable comes from firmware, not the manifest: a pin can be assigned while still configured as an input. No electrical, full signal-matrix, PWM, analog, Wi-Fi or Bluetooth fidelity is implied.');
  return lines.join('\n')+'\n';
}

export function editorFiles(directory: string, root = frameworkRoot): Record<string,string> {
  const properties={version:4,configurations:[{
    name:'ESP32',compilerPath:'',compileCommands:'${workspaceFolder}/build/compile_commands.json',
    includePath:['${workspaceFolder}/main','${workspaceFolder}/build/config'],
    browse:{path:['${workspaceFolder}/main'],limitSymbolsToIncludedHeaders:true},
    cStandard:'c17',cppStandard:'c++17',intelliSenseMode:'linux-gcc-x86',
  }]};
  const settings={'cmake.sourceDirectory':'${workspaceFolder}','cmake.buildDirectory':'${workspaceFolder}/build','cmake.configureOnOpen':false};
  const idfTask=(label: string, action: 'configure'|'build')=>({
    label,type:'process',command:'bash',
    args:['-c',[
      'if [[ -z "${IDF_PATH:-}" || ! -f "$IDF_PATH/export.sh" ]]; then',
      '  printf "%s\\n" "Open the project in its Dev Container or start VS Code from an activated ESP-IDF environment." >&2',
      '  exit 1',
      'fi',
      'source "$IDF_PATH/export.sh" >/dev/null && idf.py reconfigure || exit $?',
      'if [[ "$1" == build ]]; then',
      '  cmake --build build --parallel 2 && cd build || exit $?',
      '  flash=$(mktemp qemu_flash.XXXXXXXX) || exit $?',
      '  trap \'rm -f -- "$flash"\' EXIT',
      '  esptool.py --chip esp32 merge_bin --fill-flash-size 4MB -o "$flash" @flash_args && mv -f -- "$flash" qemu_flash.bin',
      'fi',
    ].join('\n'),'esp-idf',action],
    options:{cwd:'${workspaceFolder}'},problemMatcher:['$gcc'],
    ...(action==='build'?{group:{kind:'build',isDefault:true}}:{}),
  });
  const tasks={version:'2.0.0',tasks:[
    idfTask('ESP-IDF: Prepare IntelliSense','configure'),idfTask('ESP-IDF: Build Firmware','build'),
    ...['build','run','web','test','clean','validate','docs'].map(target=>({label:`ESPEmu: ${target}`,type:'process',command:'make',args:[target],options:{cwd:'${workspaceFolder}'},problemMatcher:target==='build'?['$gcc']:[]})),
  ]};
  const image=parseEnv(readFileSync(join(root,'versions.env'),'utf8')).IDF_IMAGE;
  if(!image)throw new Error('ESP-IDF container image pin is missing from versions.env.');
  const devContainer={
    name:'ESP-IDF',image,remoteUser:'ubuntu',updateRemoteUserUID:true,init:true,
    workspaceMount:'source=${localWorkspaceFolder},target=/workspace,type=bind',workspaceFolder:'/workspace',
    runArgs:['--cpus=2','--memory=4g'],customizations:{vscode:{extensions:['ms-vscode.cpptools']}},
  };
  return Object.fromEntries([['.vscode/c_cpp_properties.json',properties],['.vscode/settings.json',settings],['.vscode/tasks.json',tasks],['.devcontainer/devcontainer.json',devContainer]].map(([file,value])=>[file as string,JSON.stringify(value,null,2)+'\n']));
}

function deviceSdkFiles(root: string, manifest: ProjectManifest): Record<string,string> {
  if(!usesDeviceSdk(manifest))return {};
  const bme280=manifest.devices.some(device=>device.type==='bme280'),ws2812=manifest.devices.some(device=>device.type==='ws2812b'),camera=manifest.devices.some(isCamera);
  const files:Record<string,string>={'.espemu-device-sdk.cmake':'idf_component_get_property(espemu_main main COMPONENT_LIB)\ntarget_link_libraries(${espemu_main} PUBLIC idf::espemu_devices)\n'};
  for(const name of ['espemu_devices.c','include/espemu_devices.h'])files[`components/espemu_devices/${name}`]=readFileSync(join(root,'components/espemu_devices',name),'utf8');
  // Only circuits that use them pay for the Bosch sources and the managed LED-strip download.
  const disabled=[...(bme280?[]:['ESPEMU_DEVICES_NO_BME280']),...(ws2812?[]:['ESPEMU_DEVICES_NO_WS2812'])];
  files['components/espemu_devices/CMakeLists.txt']=`idf_component_register(SRCS "espemu_devices.c" INCLUDE_DIRS "include" REQUIRES driver esp_rom esp_timer${bme280?' bme280':''}${ws2812?' led_strip':''}${camera?' esp32-camera':''})\n${disabled.length?`target_compile_definitions(\${COMPONENT_LIB} PUBLIC ${disabled.join(' ')})\n`:''}`;
  const dependencies=[...(ws2812?[readFileSync(join(root,'components/espemu_devices/idf_component.yml'),'utf8').split('\n').find(line=>line.includes('led_strip'))!]:[]),...(camera?[`  espressif/esp32-camera: "${ESP32_CAMERA_VERSION}"`]:[])];
  files['components/espemu_devices/idf_component.yml']=dependencies.length?`dependencies:\n${dependencies.join('\n')}\n`:'dependencies: {}\n';
  if(bme280)for(const name of ['CMakeLists.txt','vendor/bme280.c','vendor/bme280.h','vendor/bme280_defs.h','vendor/LICENSE'])files[`components/bme280/${name}`]=readFileSync(join(root,'firmware/components/bme280',name),'utf8');
  return files;
}

export function generateProjectArtifacts(directory: string, root = frameworkRoot, force = false) {
  const project=resolve(directory);
  if(!existsSync(join(project,'CMakeLists.txt')))throw new Error(`Not an ESP-IDF project: ${project}`);
  const manifest=loadProject(root,{ESPEMU_PROJECT:project}).manifest;
  const ledgerFile=join(project,'.espemu-generated.json');
  if(lstatSync(ledgerFile,{throwIfNoEntry:false})?.isSymbolicLink())throw new Error('Generated-file record is a symlink; no files changed.');
  const ledger:Record<string,string>=existsSync(ledgerFile)?z.record(z.string().regex(/^[a-f0-9]{64}$/)).parse(JSON.parse(readFileSync(ledgerFile,'utf8'))):{};
  const reference=projectReadme(project,manifest,root);
  const files={ 'README.md':`# ${basename(project)}\n\nIn VS Code, use **Dev Containers: Reopen in Container** for the pinned ESP-IDF toolchain, then run **ESP-IDF: Prepare IntelliSense** or **ESP-IDF: Build Firmware** from **Tasks: Run Task**. The build is also the default VS Code build task. Docker and the Dev Containers extension are required only for the container workflow.\n\nSee [ESPEmu device reference](ESPEMU-DEVICES.md) for wiring, SDK examples, and project commands.\n`, 'ESPEMU-DEVICES.md':reference, 'main/device_pins.h':devicePinsHeader(manifest), ...deviceSdkFiles(root,manifest), ...editorFiles(project,root) };
  const written:string[]=[],preserved:string[]=[];
  const cmakeFile=join(project,'CMakeLists.txt'),cmake=readFileSync(cmakeFile,'utf8');
  if(usesDeviceSdk(manifest)&&lstatSync(cmakeFile).isSymbolicLink())throw new Error('Cannot install the device SDK through a symlink CMakeLists.txt.');
  for(const [relative,content] of Object.entries(files)){
    const filename=join(project,relative),parent=dirname(filename);
    let ancestor=parent,linked=false;
    while(ancestor!==project&&ancestor!==dirname(ancestor)){if(lstatSync(ancestor,{throwIfNoEntry:false})?.isSymbolicLink()){linked=true;break;}ancestor=dirname(ancestor);}
    if(linked){preserved.push(relative);continue;}
    if(lstatSync(filename,{throwIfNoEntry:false})?.isSymbolicLink()){preserved.push(relative);continue;}
    if(existsSync(filename)){
      const current=readFileSync(filename,'utf8');
      if(!force&&current!==content&&hash(current)!==ledger[relative]){preserved.push(relative);continue;}
    }
    mkdirSync(parent,{recursive:true});writeFileSync(filename,content);ledger[relative]=hash(content);written.push(relative);
  }
  if(usesDeviceSdk(manifest)&&!cmake.includes(sdkHook)){writeFileSync(cmakeFile,cmake.trimEnd()+'\n'+sdkHook+'\n');written.push('CMakeLists.txt');}
  writeFileSync(ledgerFile,JSON.stringify(ledger,null,2)+'\n');
  return {written,preserved};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const directory=process.argv[2];if(!directory)throw new Error('Usage: project-artifacts.ts PROJECT_DIRECTORY [--force]');const result=generateProjectArtifacts(directory,frameworkRoot,process.argv.includes('--force'));console.log(`Generated: ${result.written.join(', ')||'none'}`);if(result.preserved.length)console.log(`User-edited files preserved: ${result.preserved.join(', ')}`);}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
}
