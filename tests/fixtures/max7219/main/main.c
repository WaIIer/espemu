#include "espemu_devices.h"

void app_main(void)
{
    espemu_max7219_t single, chain;
    ESP_ERROR_CHECK(espemu_max7219_init(&single, GPIO_NUM_23, GPIO_NUM_18, GPIO_NUM_5, 1));
    ESP_ERROR_CHECK(espemu_max7219_init(&chain, GPIO_NUM_25, GPIO_NUM_32, GPIO_NUM_33, 2));
    const uint8_t pattern[8] = {0x81, 0x42, 0x24, 0x18, 0x18, 0x24, 0x42, 0x81};
    const uint8_t other[8] = {0xff, 0x81, 0xbd, 0xa5, 0xa5, 0xbd, 0x81, 0xff};
    ESP_ERROR_CHECK(espemu_max7219_set_rows(&single, 0, pattern));
    ESP_ERROR_CHECK(espemu_max7219_write(&single, 0, 10, 15));
    ESP_ERROR_CHECK(espemu_max7219_set_rows(&chain, 0, pattern));
    ESP_ERROR_CHECK(espemu_max7219_set_rows(&chain, 1, other));
    printf("MAX7219 ready\n");
    for (unsigned phase = 0; ; phase = (phase + 1) % 3)
    {
        ESP_ERROR_CHECK(espemu_max7219_write(&chain, 1, 15, phase == 1));
        ESP_ERROR_CHECK(espemu_max7219_write(&chain, 1, 12, phase != 2));
        printf("MAX7219 phase=%u\n", phase);
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}
