#include <stdio.h>
#include <stdint.h>
#include <math.h>
#include <string.h>
#include "sdkconfig.h"
#include "bme280.h"
#include "driver/i2c.h"
#include "device_pins.h"
#include "led_strip.h"
#include "esp_timer.h"
#include "esp_rom_sys.h"
#include "espemu_devices.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static uint8_t bme280_address = BME280_I2C_ADDRESS;
static bool bme280_ready;
static struct bme280_dev environmental;
static bool light_ready;
static bool motion_ready;
static led_strip_handle_t pixel;
static led_strip_handle_t strip;
static espemu_max7219_t matrix;

static BME280_INTF_RET_TYPE environmental_read(uint8_t reg, uint8_t *data,
                                               uint32_t length, void *context)
{
    return i2c_master_write_read_device(I2C_NUM_0, *(uint8_t *)context,
                                        &reg, 1, data, length, pdMS_TO_TICKS(40)) == ESP_OK
               ? 0
               : -1;
}

static BME280_INTF_RET_TYPE environmental_write(uint8_t reg, const uint8_t *data,
                                                uint32_t length, void *context)
{
    uint8_t frame[32];
    if (length >= sizeof(frame))
        return -1;
    frame[0] = reg;
    memcpy(frame + 1, data, length);
    return i2c_master_write_to_device(I2C_NUM_0, *(uint8_t *)context,
                                      frame, length + 1, pdMS_TO_TICKS(40)) == ESP_OK
               ? 0
               : -1;
}

static void environmental_delay(uint32_t period, void *context)
{
    if (period >= 1000)
        vTaskDelay(pdMS_TO_TICKS((period + 999) / 1000));
    else
        esp_rom_delay_us(period);
}

static esp_err_t environmental_init(void)
{
    environmental = (struct bme280_dev){
        .intf = BME280_I2C_INTF,
        .intf_ptr = &bme280_address,
        .read = environmental_read,
        .write = environmental_write,
        .delay_us = environmental_delay,
    };
    int8_t result = bme280_init(&environmental);
    const struct bme280_settings settings = {.osr_t = 1, .osr_p = 1, .osr_h = 1, .filter = 0, .standby_time = 0};
    if (result == BME280_OK)
        result = bme280_set_sensor_settings(BME280_SEL_ALL_SETTINGS, &settings, &environmental);
    if (result == BME280_OK)
        result = bme280_set_sensor_mode(BME280_POWERMODE_NORMAL, &environmental);
    bme280_ready = result == BME280_OK;
    return bme280_ready ? ESP_OK : ESP_FAIL;
}

static esp_err_t read_environment(struct bme280_data *data)
{
    if (!bme280_ready && environmental_init() != ESP_OK)
        return ESP_FAIL;
    uint8_t raw[8];
    if (bme280_get_regs(0xf7, raw, sizeof(raw), &environmental) != BME280_OK)
    {
        bme280_ready = false;
        return ESP_FAIL;
    }
    if ((raw[0] == 0x80 && raw[1] == 0 && raw[2] == 0) ||
        (raw[3] == 0x80 && raw[4] == 0 && raw[5] == 0) ||
        (raw[6] == 0x80 && raw[7] == 0))
        return ESP_ERR_INVALID_RESPONSE;
    int8_t result = bme280_get_sensor_data(BME280_ALL, data, &environmental);
    if (result != BME280_OK)
    {
        bme280_ready = false;
        return ESP_FAIL;
    }
    return ESP_OK;
}

static esp_err_t read_temperature(double *temperature)
{
    uint8_t pointer = 0;
    uint8_t data[2];
    esp_err_t error = i2c_master_write_read_device(TMP105_I2C_PORT, TMP105_I2C_ADDRESS,
                                                   &pointer, 1, data, sizeof(data), pdMS_TO_TICKS(40));
    if (error == ESP_OK)
    {
        *temperature = (int16_t)((data[0] << 8) | data[1]) / 256.0;
        if (*temperature < -55 || *temperature > 125)
            error = ESP_ERR_INVALID_RESPONSE;
    }
    return error;
}

static esp_err_t read_light(double *lux)
{
    if (!light_ready)
    {
        uint8_t command = 0x10;
        esp_err_t configured = i2c_master_write_to_device(BH1750_I2C_PORT, BH1750_I2C_ADDRESS,
                                                          &command, 1, pdMS_TO_TICKS(40));
        if (configured != ESP_OK)
            return configured;
        light_ready = true;
    }
    uint8_t data[2];
    esp_err_t error = i2c_master_read_from_device(BH1750_I2C_PORT, BH1750_I2C_ADDRESS,
                                                  data, sizeof(data), pdMS_TO_TICKS(40));
    if (error == ESP_OK)
    {
        uint16_t raw = (data[0] << 8) | data[1];
        if (raw == 0xffff)
            return ESP_ERR_INVALID_RESPONSE;
        *lux = raw / 1.2;
    }
    else
        light_ready = false;
    return error;
}

static const char *json_number(char *buffer, size_t size, double value, esp_err_t error)
{
    if (error == ESP_OK && isfinite(value))
        snprintf(buffer, size, "%.4f", value);
    else
        snprintf(buffer, size, "null");
    return buffer;
}

static esp_err_t read_motion(double values[7])
{
    if (!motion_ready)
    {
        uint8_t pointer = 0x75, identity;
        esp_err_t result = i2c_master_write_read_device(MPU6050_I2C_PORT, MPU6050_I2C_ADDRESS,
                                                        &pointer, 1, &identity, 1, pdMS_TO_TICKS(40));
        if (result != ESP_OK)
            return result;
        if (identity != 0x68)
            return ESP_ERR_INVALID_RESPONSE;
        const uint8_t sampling[] = {0x19, 9, 3, 0, 0};
        const uint8_t wake[] = {0x6b, 1};
        result = i2c_master_write_to_device(MPU6050_I2C_PORT, MPU6050_I2C_ADDRESS, sampling, sizeof(sampling), pdMS_TO_TICKS(40));
        if (result == ESP_OK)
            result = i2c_master_write_to_device(MPU6050_I2C_PORT, MPU6050_I2C_ADDRESS, wake, sizeof(wake), pdMS_TO_TICKS(40));
        if (result != ESP_OK)
            return result;
        motion_ready = true;
        vTaskDelay(pdMS_TO_TICKS(12));
    }
    uint8_t pointer = 0x3b, data[14];
    esp_err_t result = i2c_master_write_read_device(MPU6050_I2C_PORT, MPU6050_I2C_ADDRESS, &pointer, 1, data, sizeof(data), pdMS_TO_TICKS(40));
    if (result != ESP_OK)
    {
        motion_ready = false;
        return result;
    }
    unsigned invalid = 0;
    for (unsigned channel = 0; channel < 7; channel++)
    {
        int16_t raw = (int16_t)((data[channel * 2] << 8) | data[channel * 2 + 1]);
        if (raw == 32767)
            invalid++;
        values[channel] = channel < 3 ? raw / 16384.0 : channel == 3 ? raw / 340.0 + 36.53
                                                                     : raw / 131.0;
    }
    return invalid == 7 ? ESP_ERR_INVALID_RESPONSE : ESP_OK;
}

static void digital_init(void)
{
    const gpio_config_t outputs = {.pin_bit_mask = (1ULL << STATUS_LED_PIN) | (1ULL << RGB_RED_PIN) | (1ULL << RGB_GREEN_PIN) | (1ULL << RGB_BLUE_PIN), .mode = GPIO_MODE_OUTPUT};
    const gpio_config_t button = {.pin_bit_mask = 1ULL << BUTTON_PIN, .mode = GPIO_MODE_INPUT, .pull_up_en = GPIO_PULLUP_ENABLE};
    const gpio_config_t toggle = {.pin_bit_mask = 1ULL << SWITCH_PIN, .mode = GPIO_MODE_INPUT, .pull_down_en = GPIO_PULLDOWN_ENABLE};
    ESP_ERROR_CHECK(gpio_config(&outputs));
    ESP_ERROR_CHECK(gpio_set_direction(STATUS_LED_PIN, GPIO_MODE_INPUT_OUTPUT));
    ESP_ERROR_CHECK(gpio_config(&button));
    ESP_ERROR_CHECK(gpio_config(&toggle));
    const led_strip_config_t pixel_config = {.strip_gpio_num = PIXEL_PIN, .max_leds = PIXEL_LED_COUNT, .led_pixel_format = LED_PIXEL_FORMAT_GRB, .led_model = LED_MODEL_WS2812};
    const led_strip_config_t strip_config = {.strip_gpio_num = STRIP_PIN, .max_leds = STRIP_LED_COUNT, .led_pixel_format = LED_PIXEL_FORMAT_GRB, .led_model = LED_MODEL_WS2812};
    const led_strip_rmt_config_t transport = {.resolution_hz = 10000000};
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&pixel_config, &transport, &pixel));
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&strip_config, &transport, &strip));
    ESP_ERROR_CHECK(espemu_max7219_init(&matrix, MATRIX_DIN_PIN, MATRIX_CLK_PIN, MATRIX_LOAD_PIN, MATRIX_MODULE_COUNT));
}

static esp_err_t addressable_write(uint32_t sequence, bool red, bool green, bool blue, bool moving)
{
    esp_err_t result = led_strip_set_pixel(pixel, 0, red ? 255 : 0, green ? 255 : 0, blue ? 255 : 0);
    if (result == ESP_OK)
        result = led_strip_refresh(pixel);
    for (unsigned index = 0; result == ESP_OK && index < STRIP_LED_COUNT; index++)
    {
        unsigned phase = (sequence / 3 + index) % 3;
        result = led_strip_set_pixel(strip, index, moving || phase == 0 ? 160 : 0, phase == 1 ? 160 : 0, phase == 2 ? 160 : 0);
    }
    if (result == ESP_OK)
        result = led_strip_refresh(strip);
    return result;
}

void app_main(void)
{
    const i2c_config_t config = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = I2C0_SDA_PIN,
        .scl_io_num = I2C0_SCL_PIN,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = 100000,
    };
    ESP_ERROR_CHECK(i2c_param_config(I2C0_I2C_PORT, &config));
    ESP_ERROR_CHECK(i2c_driver_install(I2C0_I2C_PORT, I2C_MODE_MASTER, 0, 0, 0));
    const uint8_t resolution[] = {1, 0x20};
    i2c_master_write_to_device(TMP105_I2C_PORT, TMP105_I2C_ADDRESS, resolution,
                               sizeof(resolution), pdMS_TO_TICKS(40));
    const uint8_t continuous_high_resolution = 0x10;
    light_ready = i2c_master_write_to_device(BH1750_I2C_PORT, BH1750_I2C_ADDRESS, &continuous_high_resolution,
                                             1, pdMS_TO_TICKS(40)) == ESP_OK;
    environmental_init();
    digital_init();
    vTaskDelay(pdMS_TO_TICKS(150));
    uint32_t sequence = 0;
    TickType_t wake = xTaskGetTickCount();
    while (true)
    {
        double temperature = NAN;
        double lux = NAN;
        esp_err_t temperature_error = read_temperature(&temperature);
        esp_err_t light_error = read_light(&lux);
        struct bme280_data environment = {.temperature = NAN, .pressure = NAN, .humidity = NAN};
        esp_err_t environmental_error = read_environment(&environment);
        double motion[7] = {NAN, NAN, NAN, NAN, NAN, NAN, NAN};
        esp_err_t motion_error = read_motion(motion);
        bool moving = motion_error == ESP_OK && (fabs(motion[4]) + fabs(motion[5]) + fabs(motion[6]) > 5 || fabs(motion[0]) > .25 || fabs(motion[1]) > .25);
        bool pressed = gpio_get_level(BUTTON_PIN) == BUTTON_ACTIVE_LEVEL;
        bool switched = gpio_get_level(SWITCH_PIN) == SWITCH_ACTIVE_LEVEL;
        bool red = moving || temperature > 28 || sequence % 30 < 10;
        bool green = switched || lux < 200 || (sequence % 30 >= 10 && sequence % 30 < 20);
        bool blue = pressed || environment.humidity > 60 || sequence % 30 >= 20;
        ESP_ERROR_CHECK(gpio_set_level(STATUS_LED_PIN, moving || (sequence / 5) % 2));
        ESP_ERROR_CHECK(gpio_set_level(RGB_RED_PIN, red));
        ESP_ERROR_CHECK(gpio_set_level(RGB_GREEN_PIN, green));
        ESP_ERROR_CHECK(gpio_set_level(RGB_BLUE_PIN, blue));
        int probe_level = gpio_get_level(PROBE_PIN);
        esp_err_t addressable_error = addressable_write(sequence, red, green, blue, moving);
        if (sequence % 3 == 0)
        {
            for (uint8_t module = 0; module < MATRIX_MODULE_COUNT; module++)
            {
                uint8_t rows[8];
                for (unsigned row = 0; row < 8; row++)
                    rows[row] = (uint8_t)(0x80 >> ((sequence / 3 + row + module) % 8));
                ESP_ERROR_CHECK(espemu_max7219_set_rows(&matrix, module, rows));
            }
        }
        char temperature_text[32];
        char light_text[32];
        char environment_temperature_text[32];
        char pressure_text[32];
        char humidity_text[32];
        char motion_text[7][32];
        for (unsigned channel = 0; channel < 7; channel++)
            json_number(motion_text[channel], sizeof(motion_text[channel]), motion[channel], motion_error);
        printf("ESP_EMU {\"v\":1,\"seq\":%lu,\"guestUs\":%lld,"
               "\"tmp105\":{\"temperatureC\":%s,\"error\":%d},"
               "\"bh1750\":{\"lux\":%s,\"error\":%d},"
               "\"bme280\":{\"temperatureC\":%s,\"pressurePa\":%s,\"humidityPct\":%s,\"error\":%d},"
               "\"mpu6050\":{\"accelXg\":%s,\"accelYg\":%s,\"accelZg\":%s,\"temperatureC\":%s,\"gyroXdps\":%s,\"gyroYdps\":%s,\"gyroZdps\":%s,\"error\":%d},"
               "\"digital\":{\"buttonPressed\":%d,\"switchOn\":%d,\"probeLevel\":%d,\"error\":0},\"ws2812b\":{\"error\":%d}}\n",
               (unsigned long)sequence++, (long long)esp_timer_get_time(),
               json_number(temperature_text, sizeof(temperature_text), temperature, temperature_error), temperature_error,
               json_number(light_text, sizeof(light_text), lux, light_error), light_error,
               json_number(environment_temperature_text, sizeof(environment_temperature_text), environment.temperature, environmental_error),
               json_number(pressure_text, sizeof(pressure_text), environment.pressure, environmental_error),
               json_number(humidity_text, sizeof(humidity_text), environment.humidity, environmental_error), environmental_error,
               motion_text[0], motion_text[1], motion_text[2], motion_text[3], motion_text[4], motion_text[5], motion_text[6], motion_error,
               pressed, switched, probe_level, addressable_error);
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(100));
    }
}
