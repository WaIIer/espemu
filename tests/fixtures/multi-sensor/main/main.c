#include <stdio.h>
#include "driver/i2c.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

void app_main(void)
{
    const i2c_config_t config = {.mode = I2C_MODE_MASTER, .sda_io_num = 21, .scl_io_num = 22, .sda_pullup_en = GPIO_PULLUP_ENABLE, .scl_pullup_en = GPIO_PULLUP_ENABLE, .master.clk_speed = 100000};
    ESP_ERROR_CHECK(i2c_param_config(I2C_NUM_0, &config));
    ESP_ERROR_CHECK(i2c_driver_install(I2C_NUM_0, I2C_MODE_MASTER, 0, 0, 0));
    while (true)
    {
        for (unsigned address = 0x48; address <= 0x49; address++)
        {
            uint8_t pointer = 0, data[2] = {0};
            esp_err_t result = i2c_master_write_read_device(I2C_NUM_0, address, &pointer, 1, data, 2, pdMS_TO_TICKS(100));
            if (result == ESP_OK)
                printf("SENSOR address=%u temperature=%.1f\n", address, (int16_t)((data[0] << 8) | data[1]) / 256.0);
            else
                printf("SENSOR address=%u error=%d\n", address, result);
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
