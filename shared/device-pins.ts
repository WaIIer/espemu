import { isCamera, isSensor, isSpeaker, wiredPins } from './registry.ts';
import type { ProjectManifest } from './manifest.ts';

export function deviceMacroName(id: string): string {
  const name = id.toUpperCase().replace(/[^A-Z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  return /^[A-Z]/.test(name) ? name : `DEVICE_${name || 'PIN'}`;
}

export function devicePinsHeader(manifest: ProjectManifest): string {
  const definitions = new Map<string,string>();
  const define = (name:string,value:string) => {
    if (definitions.has(name)) throw new Error(`Device names produce duplicate pin define ${name}; choose distinct names.`);
    definitions.set(name,value);
  };
  for (const bus of manifest.buses) {
    const name=deviceMacroName(bus.id);
    define(`${name}_SDA_PIN`,`GPIO_NUM_${bus.sda}`); define(`${name}_SCL_PIN`,`GPIO_NUM_${bus.scl}`); define(`${name}_I2C_PORT`,`I2C_NUM_${bus.controller}`);
  }
  for (const device of manifest.devices) {
    const name=deviceMacroName(device.id);
    if (isSensor(device)) {
      define(`${name}_I2C_ADDRESS`,`0x${device.address.toString(16)}`); define(`${name}_I2C_PORT`,`${deviceMacroName(device.bus)}_I2C_PORT`);
      if (device.type==='hd44780') { const [columns,rows]=device.size.split('x'); define(`${name}_COLUMNS`,columns); define(`${name}_ROWS`,rows); }
    }
    else if (isSpeaker(device)) {
      define(`${name}_DIN_PIN`,`GPIO_NUM_${device.din}`); define(`${name}_BCLK_PIN`,`GPIO_NUM_${device.bclk}`); define(`${name}_LRCLK_PIN`,`GPIO_NUM_${device.lrclk}`);
    }
    else if (isCamera(device)) {
      for (const [signal,value] of Object.entries(device.signals)) define(`${name}_${signal.toUpperCase()}_PIN`,value<0?'-1':`GPIO_NUM_${value}`);
      // esp32-camera drives SCCB through its own I2C1 driver instance on the camera's SDA/SCL pins.
      define(`${name}_SCCB_PORT`,'1');
      define(`${name}_CAMERA_CONFIG(pixel_format_, frame_size_)`,`((camera_config_t){ .pin_pwdn = ${name}_PWDN_PIN, .pin_reset = ${name}_RESET_PIN, .pin_xclk = ${name}_XCLK_PIN, .pin_sccb_sda = ${name}_SDA_PIN, .pin_sccb_scl = ${name}_SCL_PIN, .pin_d7 = ${name}_D7_PIN, .pin_d6 = ${name}_D6_PIN, .pin_d5 = ${name}_D5_PIN, .pin_d4 = ${name}_D4_PIN, .pin_d3 = ${name}_D3_PIN, .pin_d2 = ${name}_D2_PIN, .pin_d1 = ${name}_D1_PIN, .pin_d0 = ${name}_D0_PIN, .pin_vsync = ${name}_VSYNC_PIN, .pin_href = ${name}_HREF_PIN, .pin_pclk = ${name}_PCLK_PIN, .xclk_freq_hz = 20000000, .ledc_timer = LEDC_TIMER_0, .ledc_channel = LEDC_CHANNEL_0, .pixel_format = (pixel_format_), .frame_size = (frame_size_), .jpeg_quality = 12, .fb_count = 1, .fb_location = CAMERA_FB_IN_DRAM, .grab_mode = CAMERA_GRAB_WHEN_EMPTY, .sccb_i2c_port = ${name}_SCCB_PORT })`);
    }
    else {
      if (device.type==='max7219') wiredPins(device).forEach((pin,index)=>define(`${name}_${['DIN','CLK','LOAD'][index]}_PIN`,`GPIO_NUM_${pin}`));
      else if (device.type==='rgb') device.pins.forEach((pin,index)=>define(`${name}_${['RED','GREEN','BLUE'][index]}_PIN`,`GPIO_NUM_${pin}`));
      else define(`${name}_PIN`,`GPIO_NUM_${device.pin}`);
      if(device.type!=='ws2812b'&&device.type!=='max7219'){define(`${name}_ACTIVE_LEVEL`,device.activeLow?'0':'1'); define(`${name}_INACTIVE_LEVEL`,device.activeLow?'1':'0');}
      if ('length' in device) define(`${name}_${device.type==='max7219'?'MODULE_COUNT':'LED_COUNT'}`,String(device.length));
    }
  }
  const includes = [
    '#include <stdbool.h>', '#include <stdint.h>', '#include <stdio.h>', '#include <string.h>',
    '#include "esp_err.h"', '#include "esp_log.h"', '#include "freertos/FreeRTOS.h"', '#include "freertos/task.h"',
    '#include "driver/gpio.h"',
    ...(manifest.buses.length?['#include "driver/i2c.h"']:[]),
    ...(manifest.devices.some(device=>device.type==='bme280')?['#include "bme280.h"']:[]),
    ...(manifest.devices.some(device=>device.type==='ws2812b')?['#include "led_strip.h"']:[]),
    ...(manifest.devices.some(device=>isSensor(device)||isSpeaker(device)||device.type==='ws2812b'||device.type==='max7219')?['#include "espemu_devices.h"']:[]),
    ...(manifest.devices.some(isCamera)?['#include "esp_camera.h"']:[]),
  ];
  return ['#pragma once',...includes,'',...Array.from(definitions,([name,value])=>`#define ${name} ${value}`),''].join('\n');
}
