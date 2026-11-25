# Support and fidelity

This page lists the pinned versions and what each device model implements. Anything not listed under "Implemented" is outside the model.

## Version pins

`versions.env` is the source of truth for these pins.

| Component | Pin |
| --- | --- |
| ESP-IDF | v5.4.2, commit f5c3654a1c2d2a01f7f67def7a0dc48e691f63c0 |
| Espressif QEMU | esp-develop-9.2.2-20261109, commit 7411393a2f61e6f0b05af00276d30780769e0839 |
| QEMU changes | `qemu/espemu.patch` |
| Bosch BME280 SensorAPI | bme280_v3.5.1, commit 3ba9abb813660f900365b56e15cac5b7848bb6c4 |
| esp32-camera | 2.1.7 |
| Node.js | 22.16.0 |
| Python | 3.11.12 |
| Build tools | CMake 3.30.5, Ninja 1.11.1.4, Meson 1.7.0, uv 0.7.13 |
| Locked dependencies | `package-lock.json`, `tools/idf-python.lock`, `tools/native-packages.lock` |
| Container images | Digests in `versions.env`, the `Dockerfile` and `packaging/images.env` |

## Device models

| Device | Implemented | Not modeled |
| --- | --- | --- |
| ESP32 | Classic dual-core machine, ROM and flash boot, FreeRTOS firmware, UART | Other Espressif chips. Real silicon timing. |
| I2C0 | Master mode, 7-bit addresses, repeated-start reads, the command and FIFO interface, completion interrupts, ACK and NACK, reset, bus-clock delay in virtual time, a bounded transaction trace | Slave mode, 10-bit addresses, pin routing, arbitration, clock stretching, long FIFO watermarks, bus waveforms |
| TMP105 at 0x48 to 0x4f | Independent instances, signed temperature at each precision, configuration and threshold registers, 27.5, 55, 110 and 220 ms conversions, shutdown and one-shot, reset, faults | The alert pin. Exact thermostat fault-queue timing. |
| BH1750 at 0x23 or 0x5c | Power and reset, continuous and one-time high, high2 and low modes, MTreg scaling, 120 and 16 ms conversions, faults | Optical accuracy |
| BME280 at 0x76 or 0x77 | Chip ID and calibration data, the register pointer, humidity latch, reset, sleep, forced and normal modes, conversion and standby timing, raw temperature, pressure and humidity decoded by the unmodified Bosch driver | Real calibration data, IIR filtering, oversampling accuracy, SPI mode |
| SHT30, SHT31, SHT35 at 0x44 or 0x45 | Single-shot measurements at each repeatability, ready after the datasheet maximum of 15, 6 or 4 ms, NACK until ready, CRC-8 words, status and clear, the heater status bit, soft reset, break | Periodic, ART and fetch modes, alerts, heater self-heating, noise. Clock-stretching commands finish at the read, because the controller cannot hold SCL. Soft reset takes effect at once, without its 1.5 ms busy time. |
| MPU6050 at 0x68 or 0x69 | Signed accelerometer and gyroscope bursts, selectable ranges, the sample-rate filter, sleep and reset | The motion processor, the FIFO and low-power cycle mode. Enabling any of them stops new samples. |
| GPIO | Output and enable registers for both banks, external 0, 1 or released inputs, IOMUX and RTCIO pulls, open drain, edge and level interrupts routed to either core | Voltage and current, the complete signal matrix, PWM, NMI, sleep and wake |
| GPIO devices | LED, RGB LED, button, switch and logic probe, each active-high or active-low | PWM dimming, resistor and current models, wired networks |
| WS2812 | Single pixels and strips driven through the RMT peripheral | Exact bit timing tolerances |
| MAX7219 | The 16-bit serial protocol from GPIO edges, daisy chains through DOUT, digit RAM, Code B decoding, intensity, scan limit, shutdown and display test | MAX7221 chip select, hardware SPI routing, timing violations, LED current and heat. See [MAX7219.md](MAX7219.md). |
| OV2640 camera | One camera on ESP32-CAM wiring, driven by unmodified esp32-camera 2.1.7: SCCB identification, DSP format and size registers, VSYNC frames, I2S0 camera-mode descriptor DMA with EOF write-back and interrupts, JPEG, RGB565 and YUV422 frames | PCLK and HREF timing, image tuning registers, the sensor's JPEG encoder, PSRAM. See [CAMERA.md](CAMERA.md). |
| HD44780 LCD on a PCF8574 at 0x20 to 0x27 or 0x38 to 0x3f | 16x2 and 20x4 displays wired P0 RS, P1 RW, P2 E, P3 backlight, P4 to P7 data. E falling-edge latching, 8-bit and 4-bit initialization, DDRAM line mapping, CGRAM glyphs, entry and display shift, the busy flag with 37 us and 1.52 ms execution times, readback, backlight, NACK. The workbench renders the A00 character ROM. | Contrast, timing finer than the busy flag, the 5x10 font, other expander wiring, the A02 ROM |
| MAX98357A speaker | One speaker on I2S0 or I2S1, found from the GPIO matrix routing. Standard-mode TX descriptor DMA paced by the PLL_D2 clock dividers, EOF, done and error interrupts, 16-bit and 32-bit stereo and mono, silence on underrun. The left and right channels are mixed and played in the browser. | The APLL clock, PDM, TDM and DAC modes, the SD_MODE and gain pins, the analog amplifier, more than one speaker |
| Digital modules | HC-SR501, HC-SR505, RCWL-0516, TTP223, A3144, SS451A, SW-520D, SW-420, KY-032, KY-026, FC-37, YL-69, MQ-2, MQ-135, KY-038, ST188 DOUT, Littelfuse 59170, SN04-N, LJ12A3-4-Z/BX and E18-D80NK, as driven, open-collector or contact outputs | Analog outputs, comparator calibration, warm-up, pulse timing, sensing physics, enable pins |
| Scenarios | Validated input snapshots on the virtual clock: ramps, sine waves, seeded noise, recorded frames, export and import | Exact replay of a whole QEMU run |
| Workbench | Every declared device, physical inputs kept separate from model state and firmware reports, charts, console, events, faults, run, pause, reset and stop | Board layout. Values the firmware or a model did not produce. |

## Model notes

The demo firmware runs the TMP105 at 10-bit precision with 55 ms conversions. It runs the BH1750 in continuous high-resolution mode and the BME280 in normal mode with 1x oversampling and no filter. The BME280 model has synthetic calibration data. Its raw readings decode to the requested values through the unmodified Bosch driver. Each model latches new data when a conversion completes.

A hardware I2C command batch holds at most 32 bytes. The firmware drivers split longer transfers, such as the BME280 calibration read, into several batches. The I2C controller comes from Espressif's QEMU. ESPEmu's patch extends that controller and does not replace it.

Reset clears the firmware, the model registers, the timers and the I2C trace. It keeps the physical inputs. A scenario file stores inputs and scenarios, not the state of the virtual machine.

Circuits with WS2812 devices run QEMU with a fixed instruction-counting quantum, so RMT refill interrupts stay on time. Idle CPUs skip ahead to the next virtual timer, so virtual time can run faster than wall-clock time.

Espressif's published support matrix lists I2C as unsupported. The pinned QEMU commit does contain a working I2C controller. ESPEmu's tests rely on that commit only, so the result may not hold for other QEMU versions.

## References

- [ESP-IDF QEMU guide](https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32/api-guides/tools/qemu.html)
- [Espressif QEMU support matrix](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/README.md)
- [Pinned I2C controller source](https://github.com/espressif/qemu/blob/7411393a2f61e6f0b05af00276d30780769e0839/hw/i2c/esp32_i2c.c)
- [Pinned ESP32 board source](https://github.com/espressif/qemu/blob/7411393a2f61e6f0b05af00276d30780769e0839/hw/xtensa/esp32.c)
- [ESP32 Technical Reference Manual](https://www.espressif.com/sites/default/files/documentation/esp32_technical_reference_manual_en.pdf)
- [TI TMP105 datasheet](https://www.ti.com/lit/ds/symlink/tmp105.pdf)
- [ROHM BH1750 datasheet](https://www.mouser.com/datasheet/2/348/bh1750fvi-e-186247.pdf)
- [Bosch BME280 datasheet](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bme280-ds002.pdf)
- [Sensirion SHT3x-DIS datasheet](https://sensirion.com/media/documents/213E6A3B/63A5A569/Datasheet_SHT3x_DIS.pdf)
- [Analog Devices MAX7219 datasheet](https://www.analog.com/media/en/technical-documentation/data-sheets/MAX7219-MAX7221.pdf)
- [Pinned esp32-camera driver](https://components.espressif.com/components/espressif/esp32-camera/versions/2.1.7)
- [Pinned Bosch driver](https://github.com/boschsensortec/BME280_SensorAPI/tree/3ba9abb813660f900365b56e15cac5b7848bb6c4)
