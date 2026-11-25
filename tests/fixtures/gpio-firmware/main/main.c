#include <stdio.h>
#include "driver/gpio.h"
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static volatile unsigned interrupt_count;
static void button_interrupt(void *context)
{
    interrupt_count++;
}

void app_main(void)
{
    const gpio_config_t outputs = {
        .pin_bit_mask = (1ULL << 2) | (1ULL << 4) | (1ULL << 16) | (1ULL << 17) | (1ULL << 18),
        .mode = GPIO_MODE_OUTPUT,
    };
    const gpio_config_t button = {
        .pin_bit_mask = 1ULL << 27,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .intr_type = GPIO_INTR_ANYEDGE,
    };
    ESP_ERROR_CHECK(gpio_config(&outputs));
    ESP_ERROR_CHECK(gpio_config(&button));
    ESP_ERROR_CHECK(gpio_install_isr_service(0));
    ESP_ERROR_CHECK(gpio_isr_handler_add(GPIO_NUM_27, button_interrupt, NULL));
    unsigned tick = 0;
    while (true)
    {
        gpio_set_level(GPIO_NUM_2, (tick / 5) & 1);
        gpio_set_level(GPIO_NUM_4, !gpio_get_level(GPIO_NUM_27));
        gpio_set_level(GPIO_NUM_16, (tick / 5) % 3 == 0);
        gpio_set_level(GPIO_NUM_17, (tick / 5) % 3 == 1);
        gpio_set_level(GPIO_NUM_18, (tick / 5) % 3 == 2);
        printf("GPIO_FRAMEWORK_TEST interrupts=%u button=%d\n", interrupt_count, gpio_get_level(GPIO_NUM_27));
        tick++;
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
