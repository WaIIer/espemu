#include <ctype.h>
#include <math.h>
#include <stdarg.h>
#include <string.h>
#include "espemu_devices.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"

static bool matrix_valid(const espemu_max7219_t *display)
{
    return display && display->length >= 1 && display->length <= 16 &&
        GPIO_IS_VALID_OUTPUT_GPIO(display->din) && GPIO_IS_VALID_OUTPUT_GPIO(display->clk) &&
        GPIO_IS_VALID_OUTPUT_GPIO(display->load) && display->din != display->clk &&
        display->din != display->load && display->clk != display->load;
}

static esp_err_t matrix_transfer(espemu_max7219_t *display, int module, uint8_t address, uint8_t data)
{
    esp_err_t result = gpio_set_level(display->clk, 0);
    if (result == ESP_OK) result = gpio_set_level(display->load, 0);
    for (int index = display->length - 1; index >= 0 && result == ESP_OK; index--)
    {
        uint16_t word = module < 0 || module == index ? ((uint16_t)address << 8) | data : 0;
        for (int bit = 15; bit >= 0 && result == ESP_OK; bit--)
        {
            result = gpio_set_level(display->din, (word >> bit) & 1);
            esp_rom_delay_us(1);
            if (result == ESP_OK) result = gpio_set_level(display->clk, 1);
            esp_rom_delay_us(1);
            if (result == ESP_OK) result = gpio_set_level(display->clk, 0);
        }
    }
    esp_rom_delay_us(1);
    if (result == ESP_OK) result = gpio_set_level(display->load, 1);
    esp_rom_delay_us(1);
    return result;
}

esp_err_t espemu_max7219_write(espemu_max7219_t *display, uint8_t module, uint8_t address, uint8_t data)
{
    if (!matrix_valid(display) || module >= display->length || address > 15)
        return ESP_ERR_INVALID_ARG;
    return matrix_transfer(display, module, address, data);
}

esp_err_t espemu_max7219_set_rows(espemu_max7219_t *display, uint8_t module, const uint8_t rows[8])
{
    if (!matrix_valid(display) || !rows || module >= display->length)
        return ESP_ERR_INVALID_ARG;
    for (uint8_t row = 0; row < 8; row++)
    {
        esp_err_t result = espemu_max7219_write(display, module, row + 1, rows[row]);
        if (result != ESP_OK) return result;
    }
    return ESP_OK;
}

esp_err_t espemu_max7219_init(espemu_max7219_t *display, gpio_num_t din, gpio_num_t clk, gpio_num_t load, uint8_t length)
{
    espemu_max7219_t config = {.din = din, .clk = clk, .load = load, .length = length};
    if (!display || !matrix_valid(&config)) return ESP_ERR_INVALID_ARG;
    *display = config;
    const gpio_config_t pins = {.pin_bit_mask = (1ULL << din) | (1ULL << clk) | (1ULL << load), .mode = GPIO_MODE_OUTPUT};
    esp_err_t result = gpio_config(&pins);
    const uint8_t initialization[][2] = {{12, 0}, {15, 0}, {9, 0}, {11, 7}, {10, 8},
        {1, 0}, {2, 0}, {3, 0}, {4, 0}, {5, 0}, {6, 0}, {7, 0}, {8, 0}, {12, 1}};
    for (unsigned index = 0; index < sizeof(initialization) / sizeof(initialization[0]) && result == ESP_OK; index++)
        result = matrix_transfer(display, -1, initialization[index][0], initialization[index][1]);
    return result;
}

esp_err_t espemu_i2c_init(i2c_port_t port, gpio_num_t sda, gpio_num_t scl, uint32_t frequency_hz)
{
    const i2c_config_t config = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = sda,
        .scl_io_num = scl,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = frequency_hz,
    };
    esp_err_t result = i2c_param_config(port, &config);
    return result == ESP_OK ? i2c_driver_install(port, I2C_MODE_MASTER, 0, 0, 0) : result;
}

#ifndef ESPEMU_DEVICES_NO_BME280
static int8_t environment_read(uint8_t reg, uint8_t *data, uint32_t length, void *context)
{
    espemu_bme280_t *sensor = context;
    sensor->last_error = i2c_master_write_read_device(sensor->port, sensor->address, &reg, 1, data, length, pdMS_TO_TICKS(100));
    return sensor->last_error == ESP_OK ? 0 : -1;
}

static int8_t environment_write(uint8_t reg, const uint8_t *data, uint32_t length, void *context)
{
    espemu_bme280_t *sensor = context;
    uint8_t frame[32];
    if (length >= sizeof(frame))
    {
        sensor->last_error = ESP_ERR_INVALID_SIZE;
        return -1;
    }
    frame[0] = reg;
    memcpy(frame + 1, data, length);
    sensor->last_error = i2c_master_write_to_device(sensor->port, sensor->address, frame, length + 1, pdMS_TO_TICKS(100));
    return sensor->last_error == ESP_OK ? 0 : -1;
}

static void environment_delay(uint32_t microseconds, void *context)
{
    if (microseconds < 1000)
        esp_rom_delay_us(microseconds);
    else
        vTaskDelay(pdMS_TO_TICKS((microseconds + 999) / 1000));
}

static esp_err_t environment_result(espemu_bme280_t *sensor, int8_t result)
{
    if (result == BME280_OK)
        return ESP_OK;
    return sensor->last_error == ESP_OK ? ESP_FAIL : sensor->last_error;
}

esp_err_t espemu_bme280_init(espemu_bme280_t *sensor, i2c_port_t port, uint8_t address)
{
    if (!sensor || (address != 0x76 && address != 0x77))
        return ESP_ERR_INVALID_ARG;
    *sensor = (espemu_bme280_t){.port = port, .address = address, .last_error = ESP_OK};
    sensor->driver = (struct bme280_dev){
        .intf = BME280_I2C_INTF,
        .intf_ptr = sensor,
        .read = environment_read,
        .write = environment_write,
        .delay_us = environment_delay,
    };
    int8_t result = bme280_init(&sensor->driver);
    const struct bme280_settings settings = {.osr_t = 1, .osr_p = 1, .osr_h = 1, .filter = 0, .standby_time = 0};
    if (result == BME280_OK)
        result = bme280_set_sensor_settings(BME280_SEL_ALL_SETTINGS, &settings, &sensor->driver);
    if (result == BME280_OK)
        result = bme280_set_sensor_mode(BME280_POWERMODE_NORMAL, &sensor->driver);
    if (result == BME280_OK)
        vTaskDelay(pdMS_TO_TICKS(20));
    return environment_result(sensor, result);
}

esp_err_t espemu_bme280_read(espemu_bme280_t *sensor, espemu_bme280_reading_t *reading)
{
    if (!sensor || !reading || sensor->driver.intf_ptr != sensor)
        return ESP_ERR_INVALID_ARG;
    uint8_t raw[8];
    int8_t result = bme280_get_regs(0xf7, raw, sizeof(raw), &sensor->driver);
    if (result != BME280_OK)
        return environment_result(sensor, result);
    if ((raw[0] == 0x80 && raw[1] == 0 && raw[2] == 0) ||
        (raw[3] == 0x80 && raw[4] == 0 && raw[5] == 0) || (raw[6] == 0x80 && raw[7] == 0))
        return ESP_ERR_INVALID_RESPONSE;
    struct bme280_data data;
    result = bme280_get_sensor_data(BME280_ALL, &data, &sensor->driver);
    if (result == BME280_OK)
        *reading = (espemu_bme280_reading_t){data.temperature, data.pressure, data.humidity};
    return environment_result(sensor, result);
}
#endif

static esp_err_t sensor_write(espemu_i2c_sensor_t *sensor, const uint8_t *bytes, size_t length)
{
    return i2c_master_write_to_device(sensor->port, sensor->address, bytes, length, pdMS_TO_TICKS(100));
}

static esp_err_t sensor_read(espemu_i2c_sensor_t *sensor, uint8_t reg, uint8_t *bytes, size_t length)
{
    return i2c_master_write_read_device(sensor->port, sensor->address, &reg, 1, bytes, length, pdMS_TO_TICKS(100));
}

static int16_t signed_word(const uint8_t *bytes)
{
    return (int16_t)(((uint16_t)bytes[0] << 8) | bytes[1]);
}

esp_err_t espemu_tmp105_init(espemu_tmp105_t *sensor, i2c_port_t port, uint8_t address)
{
    if (!sensor || address < 0x48 || address > 0x4f)
        return ESP_ERR_INVALID_ARG;
    *sensor = (espemu_tmp105_t){port, address};
    const uint8_t config[] = {1, 0x60};
    esp_err_t result = sensor_write(sensor, config, sizeof(config));
    if (result == ESP_OK)
        vTaskDelay(pdMS_TO_TICKS(230));
    return result;
}

esp_err_t espemu_tmp105_read(espemu_tmp105_t *sensor, float *temperature_c)
{
    if (!sensor || !temperature_c)
        return ESP_ERR_INVALID_ARG;
    uint8_t bytes[2];
    esp_err_t result = sensor_read(sensor, 0, bytes, sizeof(bytes));
    if (result != ESP_OK)
        return result;
    float value = signed_word(bytes) / 256.0f;
    if (value < -55 || value > 125)
        return ESP_ERR_INVALID_RESPONSE;
    *temperature_c = value;
    return ESP_OK;
}

esp_err_t espemu_bh1750_init(espemu_bh1750_t *sensor, i2c_port_t port, uint8_t address)
{
    if (!sensor || (address != 0x23 && address != 0x5c))
        return ESP_ERR_INVALID_ARG;
    *sensor = (espemu_bh1750_t){port, address};
    const uint8_t command = 0x10;
    esp_err_t result = sensor_write(sensor, &command, 1);
    if (result == ESP_OK)
        vTaskDelay(pdMS_TO_TICKS(180));
    return result;
}

esp_err_t espemu_bh1750_read(espemu_bh1750_t *sensor, float *lux)
{
    if (!sensor || !lux)
        return ESP_ERR_INVALID_ARG;
    uint8_t bytes[2];
    esp_err_t result = i2c_master_read_from_device(sensor->port, sensor->address, bytes, sizeof(bytes), pdMS_TO_TICKS(100));
    if (result != ESP_OK)
        return result;
    uint16_t value = ((uint16_t)bytes[0] << 8) | bytes[1];
    if (value == 0xffff)
        return ESP_ERR_INVALID_RESPONSE;
    *lux = value / 1.2f;
    return ESP_OK;
}

#define LCD_RS 0x01
#define LCD_E 0x04
#define LCD_BACKLIGHT 0x08

/* One I2C write clocks a nibble: data with E high, then E low latches it on the falling edge. */
static esp_err_t lcd_nibble(espemu_hd44780_t *lcd, uint8_t nibble, uint8_t rs)
{
    uint8_t port = (uint8_t)(nibble << 4) | rs | lcd->backlight;
    const uint8_t bytes[] = {port | LCD_E, port};
    return i2c_master_write_to_device(lcd->port, lcd->address, bytes, sizeof(bytes), pdMS_TO_TICKS(100));
}

static esp_err_t lcd_send(espemu_hd44780_t *lcd, uint8_t value, uint8_t rs)
{
    esp_err_t result = lcd_nibble(lcd, value >> 4, rs);
    if (result == ESP_OK)
        result = lcd_nibble(lcd, value & 0x0f, rs);
    /* Clear and home need 1.52 ms; everything else finishes within one I2C transfer (37 us). */
    if (result == ESP_OK && !rs && value <= 0x03)
        vTaskDelay(pdMS_TO_TICKS(2) + 1);
    return result;
}

esp_err_t espemu_hd44780_init(espemu_hd44780_t *lcd, i2c_port_t port, uint8_t address, uint8_t columns, uint8_t rows)
{
    if (!lcd || ((address < 0x20 || address > 0x27) && (address < 0x38 || address > 0x3f)) || !columns || columns > 40 || !rows || rows > 4)
        return ESP_ERR_INVALID_ARG;
    *lcd = (espemu_hd44780_t){port, address, columns, rows, LCD_BACKLIGHT};
    const uint8_t idle = LCD_BACKLIGHT;
    esp_err_t result = i2c_master_write_to_device(port, address, &idle, 1, pdMS_TO_TICKS(100));
    vTaskDelay(pdMS_TO_TICKS(50));
    /* Initialization by instruction (datasheet figure 24): three 8-bit function sets, then 4-bit. */
    static const uint32_t waits_us[] = {4500, 4500, 150};
    for (int step = 0; step < 3 && result == ESP_OK; step++)
    {
        result = lcd_nibble(lcd, 0x3, 0);
        esp_rom_delay_us(waits_us[step]);
    }
    if (result == ESP_OK)
        result = lcd_nibble(lcd, 0x2, 0);
    if (result == ESP_OK)
        result = lcd_send(lcd, rows > 1 ? 0x28 : 0x20, 0);
    if (result == ESP_OK)
        result = lcd_send(lcd, 0x0c, 0);
    if (result == ESP_OK)
        result = lcd_send(lcd, 0x01, 0);
    if (result == ESP_OK)
        result = lcd_send(lcd, 0x06, 0);
    return result;
}

esp_err_t espemu_hd44780_clear(espemu_hd44780_t *lcd) { return lcd ? lcd_send(lcd, 0x01, 0) : ESP_ERR_INVALID_ARG; }

esp_err_t espemu_hd44780_set_cursor(espemu_hd44780_t *lcd, uint8_t column, uint8_t row)
{
    if (!lcd || column >= lcd->columns || row >= lcd->rows)
        return ESP_ERR_INVALID_ARG;
    /* Rows 2 and 3 of a 4-line module continue DDRAM lines 0 and 1. */
    const uint8_t starts[] = {0x00, 0x40, lcd->columns, (uint8_t)(0x40 + lcd->columns)};
    return lcd_send(lcd, 0x80 | (starts[row] + column), 0);
}

esp_err_t espemu_hd44780_write_char(espemu_hd44780_t *lcd, uint8_t code) { return lcd ? lcd_send(lcd, code, LCD_RS) : ESP_ERR_INVALID_ARG; }

esp_err_t espemu_hd44780_print(espemu_hd44780_t *lcd, const char *text)
{
    if (!lcd || !text)
        return ESP_ERR_INVALID_ARG;
    esp_err_t result = ESP_OK;
    for (; *text && result == ESP_OK; text++)
        result = lcd_send(lcd, (uint8_t)*text, LCD_RS);
    return result;
}

esp_err_t espemu_hd44780_printf(espemu_hd44780_t *lcd, uint8_t column, uint8_t row, const char *format, ...)
{
    char text[41];
    va_list arguments;
    va_start(arguments, format);
    vsnprintf(text, sizeof(text), format, arguments);
    va_end(arguments);
    esp_err_t result = espemu_hd44780_set_cursor(lcd, column, row);
    if (result == ESP_OK)
        text[lcd->columns - column] = 0;
    return result == ESP_OK ? espemu_hd44780_print(lcd, text) : result;
}

esp_err_t espemu_hd44780_backlight(espemu_hd44780_t *lcd, bool on)
{
    if (!lcd)
        return ESP_ERR_INVALID_ARG;
    lcd->backlight = on ? LCD_BACKLIGHT : 0;
    const uint8_t port = lcd->backlight;
    return i2c_master_write_to_device(lcd->port, lcd->address, &port, 1, pdMS_TO_TICKS(100));
}

esp_err_t espemu_hd44780_display(espemu_hd44780_t *lcd, bool display_on, bool cursor, bool blink)
{
    return lcd ? lcd_send(lcd, 0x08 | (display_on ? 4 : 0) | (cursor ? 2 : 0) | (blink ? 1 : 0), 0) : ESP_ERR_INVALID_ARG;
}

esp_err_t espemu_hd44780_create_char(espemu_hd44780_t *lcd, uint8_t slot, const uint8_t rows[8])
{
    if (!lcd || slot > 7 || !rows)
        return ESP_ERR_INVALID_ARG;
    esp_err_t result = lcd_send(lcd, 0x40 | (slot << 3), 0);
    for (int row = 0; row < 8 && result == ESP_OK; row++)
        result = lcd_send(lcd, rows[row] & 0x1f, LCD_RS);
    /* Return to DDRAM so later text is not written into CGRAM. */
    return result == ESP_OK ? lcd_send(lcd, 0x80, 0) : result;
}

esp_err_t espemu_max98357a_init(i2s_chan_handle_t *speaker, gpio_num_t bclk, gpio_num_t lrclk, gpio_num_t din, uint32_t sample_rate_hz)
{
    if (!speaker || sample_rate_hz < 8000 || sample_rate_hz > 96000)
        return ESP_ERR_INVALID_ARG;
    i2s_chan_config_t channel = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    channel.auto_clear = true;
    esp_err_t result = i2s_new_channel(&channel, speaker, NULL);
    if (result != ESP_OK)
        return result;
    i2s_std_config_t config = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(sample_rate_hz),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = bclk, .ws = lrclk, .dout = din, .din = I2S_GPIO_UNUSED},
    };
    result = i2s_channel_init_std_mode(*speaker, &config);
    if (result == ESP_OK)
        result = i2s_channel_enable(*speaker);
    if (result != ESP_OK)
    {
        i2s_del_channel(*speaker);
        *speaker = NULL;
    }
    return result;
}

esp_err_t espemu_max98357a_tone(i2s_chan_handle_t speaker, uint32_t sample_rate_hz, uint32_t frequency_hz, uint32_t duration_ms, int16_t amplitude)
{
    if (!speaker || !sample_rate_hz || frequency_hz >= sample_rate_hz / 2 || amplitude < 0)
        return ESP_ERR_INVALID_ARG;
    int16_t frames[256 * 2];
    uint64_t total = (uint64_t)sample_rate_hz * duration_ms / 1000, sent = 0;
    double phase = 0, step = 2 * M_PI * frequency_hz / sample_rate_hz;
    while (sent < total)
    {
        size_t count = total - sent < 256 ? (size_t)(total - sent) : 256, written = 0;
        for (size_t index = 0; index < count; index++)
        {
            frames[index * 2] = frames[index * 2 + 1] = (int16_t)(amplitude * sin(phase));
            phase = fmod(phase + step, 2 * M_PI);
        }
        esp_err_t result = i2s_channel_write(speaker, frames, count * 4, &written, portMAX_DELAY);
        if (result != ESP_OK)
            return result;
        sent += written / 4;
    }
    return ESP_OK;
}

static uint8_t sht3x_crc(const uint8_t *bytes)
{
    uint8_t crc = 0xff;
    for (int index = 0; index < 2; index++)
    {
        crc ^= bytes[index];
        for (int bit = 0; bit < 8; bit++)
            crc = crc & 0x80 ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
    }
    return crc;
}

/* Waits at least the requested time: a partial first tick plus rounding up. */
static void sht3x_wait_ms(uint32_t milliseconds)
{
    vTaskDelay((milliseconds + portTICK_PERIOD_MS - 1) / portTICK_PERIOD_MS + 1);
}

static esp_err_t sht3x_command(espemu_sht3x_t *sensor, uint16_t command)
{
    const uint8_t bytes[] = {command >> 8, command & 0xff};
    return sensor_write(sensor, bytes, sizeof(bytes));
}

esp_err_t espemu_sht3x_init(espemu_sht3x_t *sensor, i2c_port_t port, uint8_t address)
{
    if (!sensor || (address != 0x44 && address != 0x45))
        return ESP_ERR_INVALID_ARG;
    *sensor = (espemu_sht3x_t){port, address};
    esp_err_t result = sht3x_command(sensor, 0x30a2);
    if (result != ESP_OK)
        return result;
    sht3x_wait_ms(2);
    uint8_t status[3];
    result = sht3x_command(sensor, 0xf32d);
    if (result == ESP_OK)
        result = i2c_master_read_from_device(sensor->port, sensor->address, status, sizeof(status), pdMS_TO_TICKS(100));
    if (result == ESP_OK && sht3x_crc(status) != status[2])
        result = ESP_ERR_INVALID_CRC;
    return result;
}

esp_err_t espemu_sht3x_read(espemu_sht3x_t *sensor, espemu_sht3x_reading_t *reading)
{
    if (!sensor || !reading)
        return ESP_ERR_INVALID_ARG;
    esp_err_t result = sht3x_command(sensor, 0x2400);
    if (result != ESP_OK)
        return result;
    /* Datasheet Table 4: high repeatability takes at most 15 ms. */
    sht3x_wait_ms(15);
    uint8_t bytes[6];
    result = i2c_master_read_from_device(sensor->port, sensor->address, bytes, sizeof(bytes), pdMS_TO_TICKS(100));
    if (result != ESP_OK)
        return result;
    if (sht3x_crc(bytes) != bytes[2] || sht3x_crc(bytes + 3) != bytes[5])
        return ESP_ERR_INVALID_CRC;
    *reading = (espemu_sht3x_reading_t){
        -45.0f + 175.0f * (((uint16_t)bytes[0] << 8) | bytes[1]) / 65535.0f,
        100.0f * (((uint16_t)bytes[3] << 8) | bytes[4]) / 65535.0f,
    };
    return ESP_OK;
}

esp_err_t espemu_mpu6050_init(espemu_mpu6050_t *sensor, i2c_port_t port, uint8_t address)
{
    if (!sensor || (address != 0x68 && address != 0x69))
        return ESP_ERR_INVALID_ARG;
    *sensor = (espemu_mpu6050_t){port, address};
    uint8_t identity;
    esp_err_t result = sensor_read(sensor, 0x75, &identity, 1);
    if (result != ESP_OK)
        return result;
    if (identity != 0x68)
        return ESP_ERR_INVALID_RESPONSE;
    const uint8_t config[] = {0x19, 9, 3, 0, 0};
    const uint8_t wake[] = {0x6b, 1};
    result = sensor_write(sensor, config, sizeof(config));
    if (result == ESP_OK)
        result = sensor_write(sensor, wake, sizeof(wake));
    if (result == ESP_OK)
        vTaskDelay(pdMS_TO_TICKS(20));
    return result;
}

esp_err_t espemu_mpu6050_read(espemu_mpu6050_t *sensor, espemu_mpu6050_reading_t *reading)
{
    if (!sensor || !reading)
        return ESP_ERR_INVALID_ARG;
    uint8_t bytes[14];
    esp_err_t result = sensor_read(sensor, 0x3b, bytes, sizeof(bytes));
    if (result != ESP_OK)
        return result;
    unsigned invalid = 0;
    for (unsigned index = 0; index < 7; index++)
        if (signed_word(bytes + index * 2) == 32767)
            invalid++;
    if (invalid == 7)
        return ESP_ERR_INVALID_RESPONSE;
    *reading = (espemu_mpu6050_reading_t){
        .gyro_x_dps = signed_word(bytes + 8) / 131.0f,
        .gyro_y_dps = signed_word(bytes + 10) / 131.0f,
        .gyro_z_dps = signed_word(bytes + 12) / 131.0f,
        .accel_x_g = signed_word(bytes) / 16384.0f,
        .accel_y_g = signed_word(bytes + 2) / 16384.0f,
        .accel_z_g = signed_word(bytes + 4) / 16384.0f,
        .temperature_c = signed_word(bytes + 6) / 340.0f + 36.53f,
    };
    return ESP_OK;
}

#ifndef ESPEMU_DEVICES_NO_WS2812
esp_err_t espemu_ws2812_init(led_strip_handle_t *strip, gpio_num_t pin, uint32_t length)
{
    if (!strip || !length || length > 1024)
        return ESP_ERR_INVALID_ARG;
    const led_strip_config_t config = {.strip_gpio_num = pin, .max_leds = length, .led_pixel_format = LED_PIXEL_FORMAT_GRB, .led_model = LED_MODEL_WS2812};
    const led_strip_rmt_config_t transport = {.resolution_hz = 10000000};
    return led_strip_new_rmt_device(&config, &transport, strip);
}
#endif

static void telemetry_append(espemu_telemetry_t *packet, const char *format, ...)
{
    if (packet->truncated)
        return;
    va_list arguments;
    va_start(arguments, format);
    int written = vsnprintf(packet->text + packet->length, sizeof(packet->text) - packet->length, format, arguments);
    va_end(arguments);
    if (written < 0 || (size_t)written >= sizeof(packet->text) - packet->length)
        packet->truncated = true;
    else
        packet->length += written;
}

static bool telemetry_name(const char *text, size_t limit)
{
    size_t length = text ? strlen(text) : 0;
    if (!length || length > limit)
        return false;
    for (size_t index = 0; index < length; index++)
        if (!isalnum((unsigned char)text[index]) && !strchr("_.-:/%", text[index]))
            return false;
    return true;
}

void espemu_telemetry_begin(espemu_telemetry_t *packet)
{
    if (packet)
        *packet = (espemu_telemetry_t){0};
}

static void telemetry_channel(espemu_telemetry_t *packet, const char *name, const char *unit, bool present, double value)
{
    if (!packet)
        return;
    if (!telemetry_name(name, 150) || (unit && *unit && !telemetry_name(unit, 30)) || packet->channels >= 64)
    {
        packet->truncated = true;
        return;
    }
    telemetry_append(packet, "%s\"%s\":{\"value\":", packet->channels ? "," : "", name);
    if (present && isfinite(value))
        telemetry_append(packet, "%.9g", value);
    else
        telemetry_append(packet, "null");
    telemetry_append(packet, ",\"unit\":\"%s\"}", unit ? unit : "");
    packet->channels++;
}

void espemu_telemetry_value(espemu_telemetry_t *packet, const char *name, double value, const char *unit)
{
    telemetry_channel(packet, name, unit, true, value);
}

void espemu_telemetry_missing(espemu_telemetry_t *packet, const char *name, const char *unit)
{
    telemetry_channel(packet, name, unit, false, 0);
}

esp_err_t espemu_telemetry_send(espemu_telemetry_t *packet)
{
    static uint32_t sequence;
    if (!packet)
        return ESP_ERR_INVALID_ARG;
    if (packet->truncated)
        return ESP_ERR_INVALID_SIZE;
    printf("ESP_EMU {\"v\":1,\"seq\":%lu,\"guestUs\":%lld,\"channels\":{%s}}\n", (unsigned long)sequence++, (long long)esp_timer_get_time(), packet->text);
    return ESP_OK;
}
