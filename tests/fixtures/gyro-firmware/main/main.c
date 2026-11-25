#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include "device_pins.h"
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

void app_main(void)
{
    const i2c_config_t bus = {.mode = I2C_MODE_MASTER, .sda_io_num = MOTION_BUS_SDA_PIN, .scl_io_num = MOTION_BUS_SCL_PIN, .sda_pullup_en = GPIO_PULLUP_ENABLE, .scl_pullup_en = GPIO_PULLUP_ENABLE, .master.clk_speed = 100000};
    ESP_ERROR_CHECK(i2c_param_config(MOTION_I2C_PORT, &bus));
    ESP_ERROR_CHECK(i2c_driver_install(MOTION_I2C_PORT, I2C_MODE_MASTER, 0, 0, 0));
    const uint8_t wake[] = {0x6b, 1};
    const uint8_t sampling[] = {0x19, 9, 3};
    ESP_ERROR_CHECK(i2c_master_write_to_device(MOTION_I2C_PORT, MOTION_I2C_ADDRESS, sampling, sizeof(sampling), pdMS_TO_TICKS(100)));
    ESP_ERROR_CHECK(i2c_master_write_to_device(MOTION_I2C_PORT, MOTION_I2C_ADDRESS, wake, sizeof(wake), pdMS_TO_TICKS(100)));
    ESP_ERROR_CHECK(gpio_set_direction(INDICATOR_PIN, GPIO_MODE_OUTPUT));
    unsigned sequence = 0;
    while (true)
    {
        uint8_t pointer = 0x3b;
        uint8_t bytes[14];
        esp_err_t result = i2c_master_write_read_device(MOTION_I2C_PORT, MOTION_I2C_ADDRESS, &pointer, 1, bytes, sizeof(bytes), pdMS_TO_TICKS(100));
        if (result == ESP_OK)
        {
            float acceleration[3], rotation[3];
            for (unsigned axis = 0; axis < 3; axis++)
            {
                acceleration[axis] = (int16_t)((bytes[axis * 2] << 8) | bytes[axis * 2 + 1]) / 16384.0f;
                rotation[axis] = (int16_t)((bytes[axis * 2 + 8] << 8) | bytes[axis * 2 + 9]) / 131.0f;
            }
            float speed = fabsf(rotation[0]) + fabsf(rotation[1]) + fabsf(rotation[2]);
            unsigned active = speed > 5 || fabsf(acceleration[0]) > .25f || fabsf(acceleration[1]) > .25f;
            ESP_ERROR_CHECK(gpio_set_level(INDICATOR_PIN, active));
            printf("ESP_EMU {\"v\":1,\"seq\":%u,\"channels\":{\"rotation.x\":{\"value\":%.3f,\"unit\":\"deg/s\"},\"rotation.y\":{\"value\":%.3f,\"unit\":\"deg/s\"},\"rotation.z\":{\"value\":%.3f,\"unit\":\"deg/s\"},\"acceleration.x\":{\"value\":%.3f,\"unit\":\"g\"},\"acceleration.y\":{\"value\":%.3f,\"unit\":\"g\"},\"acceleration.z\":{\"value\":%.3f,\"unit\":\"g\"},\"indicator\":{\"value\":%u,\"unit\":\"\"}}}\n", sequence++, rotation[0], rotation[1], rotation[2], acceleration[0], acceleration[1], acceleration[2], active);
        }
        else
        {
            printf("Motion I2C error=%d\n", result);
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}
