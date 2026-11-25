#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include "driver/gpio.h"
#include "driver/i2c.h"
#include "driver/i2s_std.h"
#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#ifndef ESPEMU_DEVICES_NO_BME280
#include "bme280.h"
#endif
#ifndef ESPEMU_DEVICES_NO_WS2812
#include "led_strip.h"
#endif

#ifdef __cplusplus
extern "C"
{
#endif

#ifndef ESPEMU_DEVICES_NO_BME280
    typedef struct
    {
        i2c_port_t port;
        uint8_t address;
        esp_err_t last_error;
        struct bme280_dev driver;
    } espemu_bme280_t;
#endif

    typedef struct
    {
        double temperature_c;
        double pressure_pa;
        double humidity_pct;
    } espemu_bme280_reading_t;

    typedef struct
    {
        i2c_port_t port;
        uint8_t address;
    } espemu_i2c_sensor_t;
    typedef espemu_i2c_sensor_t espemu_tmp105_t;
    typedef espemu_i2c_sensor_t espemu_bh1750_t;
    typedef espemu_i2c_sensor_t espemu_sht3x_t;
    typedef struct
    {
        float temperature_c;
        float humidity_pct;
    } espemu_sht3x_reading_t;
    typedef espemu_i2c_sensor_t espemu_mpu6050_t;

    typedef struct
    {
        float gyro_x_dps;
        float gyro_y_dps;
        float gyro_z_dps;
        float accel_x_g;
        float accel_y_g;
        float accel_z_g;
        float temperature_c;
    } espemu_mpu6050_reading_t;

    esp_err_t espemu_i2c_init(i2c_port_t port, gpio_num_t sda, gpio_num_t scl, uint32_t frequency_hz);
#ifndef ESPEMU_DEVICES_NO_BME280
    esp_err_t espemu_bme280_init(espemu_bme280_t *sensor, i2c_port_t port, uint8_t address);
    esp_err_t espemu_bme280_read(espemu_bme280_t *sensor, espemu_bme280_reading_t *reading);
#endif
    esp_err_t espemu_tmp105_init(espemu_tmp105_t *sensor, i2c_port_t port, uint8_t address);
    esp_err_t espemu_tmp105_read(espemu_tmp105_t *sensor, float *temperature_c);
    esp_err_t espemu_bh1750_init(espemu_bh1750_t *sensor, i2c_port_t port, uint8_t address);
    esp_err_t espemu_bh1750_read(espemu_bh1750_t *sensor, float *lux);
    /* Sensirion SHT3x (SHT30/SHT31/SHT35) at 0x44 or 0x45; read returns ESP_ERR_INVALID_CRC on a corrupt word. */
    esp_err_t espemu_sht3x_init(espemu_sht3x_t *sensor, i2c_port_t port, uint8_t address);

    /* HD44780 character LCD on a PCF8574 backpack (P0 RS, P1 RW, P2 E, P3 backlight, P4-P7 D4-D7). */
    typedef struct
    {
        i2c_port_t port;
        uint8_t address;
        uint8_t columns;
        uint8_t rows;
        uint8_t backlight;
    } espemu_hd44780_t;
    esp_err_t espemu_hd44780_init(espemu_hd44780_t *lcd, i2c_port_t port, uint8_t address, uint8_t columns, uint8_t rows);
    esp_err_t espemu_hd44780_clear(espemu_hd44780_t *lcd);
    esp_err_t espemu_hd44780_set_cursor(espemu_hd44780_t *lcd, uint8_t column, uint8_t row);
    esp_err_t espemu_hd44780_write_char(espemu_hd44780_t *lcd, uint8_t code);
    esp_err_t espemu_hd44780_print(espemu_hd44780_t *lcd, const char *text);
    esp_err_t espemu_hd44780_printf(espemu_hd44780_t *lcd, uint8_t column, uint8_t row, const char *format, ...)
        __attribute__((format(printf, 4, 5)));
    esp_err_t espemu_hd44780_backlight(espemu_hd44780_t *lcd, bool on);
    esp_err_t espemu_hd44780_display(espemu_hd44780_t *lcd, bool display_on, bool cursor, bool blink);
    esp_err_t espemu_hd44780_create_char(espemu_hd44780_t *lcd, uint8_t slot, const uint8_t rows[8]);

    /* MAX98357A on I2S1 (leaving I2S0 to a camera): 16-bit stereo standard I2S, enabled and ready for i2s_channel_write. */
    esp_err_t espemu_max98357a_init(i2s_chan_handle_t *speaker, gpio_num_t bclk, gpio_num_t lrclk, gpio_num_t din, uint32_t sample_rate_hz);
    /* Blocks while a sine tone of the given amplitude (0-32767) plays. */
    esp_err_t espemu_max98357a_tone(i2s_chan_handle_t speaker, uint32_t sample_rate_hz, uint32_t frequency_hz, uint32_t duration_ms, int16_t amplitude);
    esp_err_t espemu_sht3x_read(espemu_sht3x_t *sensor, espemu_sht3x_reading_t *reading);
    esp_err_t espemu_mpu6050_init(espemu_mpu6050_t *sensor, i2c_port_t port, uint8_t address);
    esp_err_t espemu_mpu6050_read(espemu_mpu6050_t *sensor, espemu_mpu6050_reading_t *reading);
#ifndef ESPEMU_DEVICES_NO_WS2812
    esp_err_t espemu_ws2812_init(led_strip_handle_t *strip, gpio_num_t pin, uint32_t length);
#endif
    typedef struct
    {
        gpio_num_t din, clk, load;
        uint8_t length;
    } espemu_max7219_t;
    esp_err_t espemu_max7219_init(espemu_max7219_t *display, gpio_num_t din, gpio_num_t clk, gpio_num_t load, uint8_t length);
    esp_err_t espemu_max7219_write(espemu_max7219_t *display, uint8_t module, uint8_t address, uint8_t data);
    esp_err_t espemu_max7219_set_rows(espemu_max7219_t *display, uint8_t module, const uint8_t rows[8]);

    /* Optional application observations printed as one ESP_EMU line; values that are absent are sent as null. */
    typedef struct
    {
        char text[1024];
        size_t length;
        uint8_t channels;
        bool truncated;
    } espemu_telemetry_t;
    void espemu_telemetry_begin(espemu_telemetry_t *packet);
    void espemu_telemetry_value(espemu_telemetry_t *packet, const char *name, double value, const char *unit);
    void espemu_telemetry_missing(espemu_telemetry_t *packet, const char *name, const char *unit);
    esp_err_t espemu_telemetry_send(espemu_telemetry_t *packet);

#ifdef __cplusplus
}
#endif
