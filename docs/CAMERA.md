# OV2640 camera

ESPEmu emulates an OV2640 on an AI-Thinker ESP32-CAM board. Firmware uses Espressif's [esp32-camera](https://github.com/espressif/esp32-camera) driver without changes. The workbench supplies pictures from your webcam or a test pattern. The emulated sensor sends them through the ESP32's I2S0 camera DMA, as the real sensor does.

## Add a camera

```sh
DEVICE=ov2640 make add_component
```

The terminal wizard and the browser creator use the AI-Thinker wiring:

| Signal | GPIO | Signal | GPIO |
| --- | --- | --- | --- |
| SCCB SDA and SCL | 26 and 27 | VSYNC | 25 |
| D0 to D3 | 5, 18, 19, 21 | HREF | 23 |
| D4 to D7 | 36, 39, 34, 35 | PCLK | 22 |
| XCLK | 0 | PWDN | 32 |

RESET is not connected. To use different wiring, override single signals. The other signals keep their defaults. A value of `-1` marks PWDN or RESET as not connected:

```sh
DEVICE='{"type":"ov2640","id":"eye","signals":{"pwdn":-1,"xclk":4}}' make add_component
```

A project can have one camera. This board uses GPIO21 and GPIO22 for camera data, so a project with a camera cannot also declare the I2C0 sensor bus.

## Firmware

`device_pins.h` includes `esp_camera.h` and defines every pin macro and a ready `camera_config_t`. ESPEmu adds the pinned `espressif/esp32-camera` 2.1.7 component to the project and links it:

```c
#include "device_pins.h"

void app_main(void)
{
    camera_config_t config = CAMERA_CAMERA_CONFIG(PIXFORMAT_JPEG, FRAMESIZE_QVGA);
    ESP_ERROR_CHECK(esp_camera_init(&config));
    for (;;) {
        camera_fb_t *frame = esp_camera_fb_get();
        if (frame) {
            printf("%ux%u, %u bytes\n", frame->width, frame->height, (unsigned)frame->len);
            esp_camera_fb_return(frame);
        }
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}
```

The macro sets a 20 MHz XCLK on LEDC timer 0 and channel 0, one frame buffer in internal DRAM, `CAMERA_GRAB_WHEN_EMPTY` and SCCB on I2C1. Write your own `camera_config_t` for other settings. The emulated board has no PSRAM, so frame buffers come from internal RAM. Use `FRAMESIZE_QVGA` or smaller for raw formats. esp32-camera 2.0.15 and older programs 128x128 when firmware asks for `FRAMESIZE_QQVGA`. The camera panel always shows the size that the driver programmed.

## Workbench

The camera panel is on the Circuit tab. Choose **Webcam** or **Test pattern**. The browser crops the picture to the sensor's aspect ratio and scales it to the output size that the firmware set. Then it encodes the picture in the configured format:

- JPEG, compressed until it fits in width times height divided by 8 bytes. A real OV2640 produces about that size at the driver's default quality, and it fits esp32-camera's DRAM frame buffer.
- RGB565, big-endian, in the order the sensor puts it on D0 to D7.
- YUV422 as YUYV, BT.601 limited range.

The panel shows the sensor output, frames sent, frames delivered by DMA, frames missed and DMA statistics. A frame is missed when the firmware has no DMA transfer running. esp32-camera with one frame buffer takes every other frame, as it does on hardware. Webcam capture needs a secure origin. The default workbench URL `http://127.0.0.1` counts as one.

Regression tests send frames directly:

```js
await project.cameraFrame('camera', { format: 'jpeg', width: 320, height: 240, data: jpegBytes });
await project.waitFor(state => state.camera.framesDelivered > 0);
```

## Emulated

- SCCB register banks on I2C1, with PID 0x26, VER 0x42, MID 0x7FA2 and the COM7 soft reset. DSP register 0xDA sets the output format, and ZMOW, ZMOH and ZMHH set the size.
- VSYNC as a real GPIO input with a 1 ms high pulse. Its falling edge starts each frame. Frames come every 100 ms, which is 10 frames per second.
- I2S0 camera mode with `lldesc_t` descriptor chains in internal DRAM. The model writes back the owner, length and EOF fields and honors `rx_eof_num`. It raises the `in_suc_eof`, `in_done`, descriptor error and empty interrupts. It supports the three ESP32 sampling modes that esp32-camera uses.
- Data at 2 MB/s. At each EOF block, the sensor waits up to 20 ms for the firmware to handle the interrupt before it continues. During blanking, it waits up to 20 ms for the firmware to start DMA. These waits keep captures independent of how busy the host is.

## Not emulated

- PCLK and HREF waveforms, XCLK frequency checks and line timing. The firmware sees VSYNC and the DMA results, not pixel clock edges.
- Image processing registers. Exposure, gain, white balance, effects, mirroring and flipping do not change the picture.
- The sensor's JPEG encoder. The browser compresses the picture instead.
- PSRAM, the LCD_CAM peripheral of the ESP32-S2 and ESP32-S3, other sensors and a second camera.

## Tests

The [camera integration test](../tests/project-creator-integration.test.ts) and the [browser test](../e2e/camera.spec.ts) cover the whole path. The browser test feeds Chromium's synthetic webcam into a fixture whose firmware decodes every JPEG it captures:

```sh
espemu new /tmp/camera --config tests/fixtures/camera/project-config.json
cp tests/fixtures/camera/main.c /tmp/camera/main/main.c
make -C /tmp/camera build
CAMERA_PROJECT=/tmp/camera npx playwright test --config playwright.camera.config.ts
```
