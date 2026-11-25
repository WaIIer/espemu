#include <stdio.h>
#include "led_strip.h"
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

void app_main(void)
{
    led_strip_handle_t pixel, strip;
    const led_strip_config_t pixel_config = {.strip_gpio_num = 18, .max_leds = 1};
    const led_strip_config_t strip_config = {.strip_gpio_num = 19, .max_leds = 8};
    const led_strip_rmt_config_t transport = {.resolution_hz = 10000000};
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&pixel_config, &transport, &pixel));
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&strip_config, &transport, &strip));
    unsigned phase = 0;
    while (true)
    {
        ESP_ERROR_CHECK(led_strip_set_pixel(pixel, 0, phase % 2 ? 0 : 255, phase % 2 ? 255 : 0, 0));
        ESP_ERROR_CHECK(led_strip_refresh(pixel));
        for (unsigned index = 0; index < 8; index++)
            ESP_ERROR_CHECK(led_strip_set_pixel(strip, index, index * 20, 10, phase % 2 ? 80 : 0));
        ESP_ERROR_CHECK(led_strip_refresh(strip));
        printf("WS2812 phase=%u\n", phase++);
        vTaskDelay(pdMS_TO_TICKS(250));
    }
}
