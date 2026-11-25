# KiCad electrical export

`make kicad` exports the validated project manifest into `kicad/`. Open
`espemu.kicad_pro` with KiCad 7 or newer. Embedded symbols make the schematic
portable without a network connection or an ESPEmu-specific symbol installation.
Standard KiCad footprint libraries are needed for footprint assignment and PCB
work. No simulator, firmware build or KiCad installation is needed to generate.

The hardware target is specifically **ESP32-WROOM-32 with an externally regulated
3.3 V supply**. The manifest does not describe a development board, regulator,
battery or connector vendor, so those are not inferred. Supply at least 500 mA
for the ESP32 plus the peripheral load; never feed 5 V into the input header.
The main sheet includes local bulk/bypass capacitors, EN pull-up/RC delay, GPIO0
boot pull-up, reset/boot buttons and a 3.3 V UART programming header.

## Qualified sensor circuits

| Manifest type | Physical part / KiCad symbol | Electrical profile |
| --- | --- | --- |
| `bme280` | `Sensor:BME280`, Bosch LGA-8 | VDD/VDDIO at 3.3 V, both grounds connected, separate 100 nF bypasses, CSB directly to VDDIO, SDO low for 0x76 or high for 0x77. |
| `sht3x` | `Sensor_Humidity:SHT31-DIS`, Sensirion DFN-8 with exposed pad | 3.3 V with 100 nF bypass, ADDR low for 0x44 or high for 0x45, R/VSS/exposed pad grounded, unused ALERT/nRESET floating. The family maps deliberately to SHT31-DIS, not an unspecified breakout. |
| `mpu6050` | `Sensor_Motion:MPU-6050`, InvenSense QFN-24 | VDD/VLOGIC at 3.3 V with separate 100 nF/10 nF bypasses; REGOUT has 100 nF to ground, CPOUT has 2.2 nF X7R/50 V/10% to ground. AD0 selects 0x68/0x69; CLKIN/FSYNC grounded; unused AUX/INT/reserved pins unconnected. |
| `a3144` | `ESPEmu:A3144UA`, bare Allegro three-pin Hall switch | Pin 1 at separately supplied 5 V with 100 nF bypass, pin 2 at common GND, pin 3 open-collector output with 10 kOhm pull-up to **3.3 V**, not 5 V. Only active-low declarations are included. Verify the physical UA lead arrangement before assigning a footprint; none is guessed. |

References:

- [Bosch BME280 datasheet](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bme280-ds002.pdf), interface selection, pinout and connection diagrams.
- [Sensirion SHT3x-DIS datasheet](https://sensirion.com/file/datasheet_sht3x_digital), pin assignment and typical application circuit.
- [InvenSense MPU-6000/MPU-6050 product specification](https://invensense.tdk.com/wp-content/uploads/2015/02/MPU-6000-Datasheet1.pdf), sections 7.1-7.2.
- [Allegro A3141/2/3/4 datasheet](https://www.allegromicro.com/~/media/files/datasheets/a3141-2-3-4-datasheet.ashx), package pinout, 4.5-24 V supply and open-collector output characteristics.
- [Espressif ESP32-WROOM-32 datasheet](https://www.espressif.com/sites/default/files/documentation/esp32-wroom-32_datasheet_en.pdf) and [hardware design guidelines](https://www.espressif.com/sites/default/files/documentation/esp32_hardware_design_guidelines_en.pdf).

One pair of 2.2 kOhm pull-ups serves the included I2C sensors. At 400 kHz,
keep total bus capacitance below 160 pF; at 100 kHz, below 400 pF. Verify the
actual rise time and sink current, including wiring and probes. Do not add
breakout-module pull-ups in parallel. Bus-only manifests or buses whose devices
are all omitted do not acquire fictitious loads.

When an A3144 is included, the root adds a separate `5V HALL INPUT` header.
Supply at least 10 mA per Hall sensor and join the grounds of the external
3.3 V and 5 V supplies. No connection joins the two positive supply rails.
An active-high Hall declaration is omitted instead of silently changing its
polarity or inventing an inverter.

## GPIO circuits

LEDs use 1 kOhm series current limiting, with the anode/cathode connections
reversed appropriately for active-low operation. RGB LEDs use common-anode or
common-cathode symbols with red/common/green/blue pin order and one resistor per
channel. Select a real part with that pin order and assign its footprint.
Buttons/switches connect to their asserted rail and use an external 10 kOhm
inactive-state bias, including on GPIO34-39. Probes are passive test points.
Generic LED/switch/test-point footprints are deliberately left unassigned.

Peripherals on boot-strapping GPIO0/2/5/12/15 are omitted until their power-on
loading has been qualified. GPIO37/38 are not exposed on WROOM-32. GPIO1/3 users
must disconnect UART programmer drives during peripheral operation.
Contacts on GPIO1 are omitted because the ESP32's own boot UART transmitter
can otherwise be shorted to a rail, even with no programmer attached.

## Deliberate omissions

Every other current device type has an explicit omission reason in the report.
In particular:

- TMP105 has only two physical addresses, not all eight simulated addresses;
  its six-ball package/land pattern has not been qualified.
- BH1750FVI needs a guaranteed DVI reset interval after VCC rises. A direct VCC
  tie or an unqualified RC delay is not a complete circuit.
- SS451A is an omnipolar sensor, not the latch named by the emulator.
- Named digital modules do not establish their connector ordering, comparator
  network, onboard pull-up rail or ESP32 voltage compatibility.
- Industrial sensors need a qualified higher-voltage/protected interface.
- WS2812B, MAX7219, LCD, amplifier and camera profiles need complete power,
  level-shifting, load or exact module/connector designs before inclusion.

An omission never produces a placeholder component, connector or wire.
Simulation faults and physical-input values do not change the hardware circuit.

The web project creator and `make add_component` show the same omission reason
when you pick an affected device type or pin. Both read the rules from
`shared/kicad-support.ts`, which the exporter also uses.

## Artifacts and regeneration

The root schematic links one sheet per included device. Explicit global net
labels and wire segments connect real numbered pins across sheets. Every pin
is connected or explicitly unconnected, including hidden/stacked power pins.
No UART-derived or browser-only connection is used.

`export-report.json` contains the normalized manifest hash, per-instance
dispositions, component references, purposes, footprints, datasheet URLs and
pin-to-net maps. `bom.csv` is an ungrouped BOM. `README.txt` repeats supply,
placement and omission warnings. Generated symbols come from KiCad community
`kicad-symbols` 7.0.11, under CC-BY-SA-4.0 with the electronic-design exception;
the full license is included in the export and in `tools/kicad/`. The A3144UA
symbol is original ESPEmu geometry with datasheet-derived numbered pins.

Regeneration updates unchanged generated files using the existing hash ledger.
If a bundle file has user edits or is a symlink, the entire bundle is preserved
and the export command fails explicitly. Keep edited designs separately if
you want a fresh generated reference. Deleted-device sheets may remain as
unreferenced files; only sheets linked from the current root are part of the
current circuit.

Run KiCad ERC and inspect the schematic/netlist before assigning footprints or
creating a PCB. Place each bypass at the pin named in its BOM purpose; observe
antenna keepouts and sensor layout requirements. This export does not claim
production qualification, physical hardware testing, PCB routing, EMC or
thermal validation.

The focused check is
`node --import tsx --test tests/kicad-export.test.ts` after sourcing
`tools/env.sh`. With `kicad-cli` installed, it exports the actual hierarchy and
checks every resulting net against the intended pin map. Without KiCad, that
integration check is explicitly skipped rather than claimed as verified.
