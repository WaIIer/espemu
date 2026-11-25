#include "espemu_devices.h"

extern "C" void app_main(void)
{
    ESP_ERROR_CHECK(espemu_i2c_init(I2C_NUM_0, GPIO_NUM_21, GPIO_NUM_22, 100000));
    espemu_bme280_t sensor;
    ESP_ERROR_CHECK(espemu_bme280_init(&sensor, I2C_NUM_0, 0x76));
    espemu_tmp105_t temperature;
    espemu_bh1750_t light;
    espemu_mpu6050_t motion;
    led_strip_handle_t pixel;
    ESP_ERROR_CHECK(espemu_tmp105_init(&temperature, I2C_NUM_0, 0x48));
    ESP_ERROR_CHECK(espemu_bh1750_init(&light, I2C_NUM_0, 0x23));
    ESP_ERROR_CHECK(espemu_mpu6050_init(&motion, I2C_NUM_0, 0x68));
    ESP_ERROR_CHECK(espemu_ws2812_init(&pixel, GPIO_NUM_18, 1));
    while (true)
    {
        espemu_bme280_reading_t reading;
        esp_err_t result = espemu_bme280_read(&sensor, &reading);
        if (result == ESP_OK)
            printf("SDK temperature=%.2f pressure=%.0f humidity=%.2f\n", reading.temperature_c, reading.pressure_pa, reading.humidity_pct);
        else
            printf("SDK error=%d\n", result);
        float measured_temperature, measured_light;
        espemu_mpu6050_reading_t measured_motion;
        ESP_ERROR_CHECK(espemu_tmp105_read(&temperature, &measured_temperature));
        ESP_ERROR_CHECK(espemu_bh1750_read(&light, &measured_light));
        ESP_ERROR_CHECK(espemu_mpu6050_read(&motion, &measured_motion));
        printf("SDK tmp=%.2f lux=%.1f gyro=%.2f\n", measured_temperature, measured_light, measured_motion.gyro_x_dps);
        ESP_ERROR_CHECK(led_strip_set_pixel(pixel, 0, 255, 0, 0));
        ESP_ERROR_CHECK(led_strip_refresh(pixel));
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}
