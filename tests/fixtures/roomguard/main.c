#include "device_pins.h"

static void acknowledge(void *argument)
{
    BaseType_t yield = pdFALSE;
    vTaskNotifyGiveFromISR((TaskHandle_t)argument, &yield);
    if (yield) portYIELD_FROM_ISR();
}

void app_main(void)
{
    const gpio_num_t outputs[] = { ALARM_PIN, NIGHT_PIN, SENSOR_FAULT_PIN };
    for (size_t index = 0; index < sizeof(outputs) / sizeof(outputs[0]); index++) {
        ESP_ERROR_CHECK(gpio_set_direction(outputs[index], GPIO_MODE_OUTPUT));
    }
    ESP_ERROR_CHECK(gpio_set_level(SENSOR_FAULT_PIN, SENSOR_FAULT_ACTIVE_LEVEL));
    ESP_ERROR_CHECK(gpio_set_direction(ACKNOWLEDGE_PIN, GPIO_MODE_INPUT));
    ESP_ERROR_CHECK(gpio_set_pull_mode(ACKNOWLEDGE_PIN, GPIO_PULLUP_ONLY));
    ESP_ERROR_CHECK(gpio_set_intr_type(ACKNOWLEDGE_PIN, GPIO_INTR_NEGEDGE));
    ESP_ERROR_CHECK(gpio_install_isr_service(0));
    ESP_ERROR_CHECK(gpio_isr_handler_add(ACKNOWLEDGE_PIN, acknowledge, xTaskGetCurrentTaskHandle()));
    ESP_ERROR_CHECK(espemu_i2c_init(I2C0_I2C_PORT, I2C0_SDA_PIN, I2C0_SCL_PIN, 100000));

    espemu_bme280_t climate;
    espemu_bh1750_t ambient;
#ifdef OUTSIDE_I2C_ADDRESS
    espemu_tmp105_t outside;
    ESP_ERROR_CHECK(espemu_tmp105_init(&outside, OUTSIDE_I2C_PORT, OUTSIDE_I2C_ADDRESS));
#endif
    bool climate_ready = false, ambient_ready = false;
    bool alarm = false, muted = false, night = false;
    unsigned sequence = 0, acknowledgements = 0;
    for (;;) {
        espemu_bme280_reading_t environment = { 0 };
        float lux = 0, outside_c = 0;
        esp_err_t climate_error = climate_ready ? ESP_OK : espemu_bme280_init(&climate, CLIMATE_I2C_PORT, CLIMATE_I2C_ADDRESS);
        esp_err_t light_error = ambient_ready ? ESP_OK : espemu_bh1750_init(&ambient, LIGHT_I2C_PORT, LIGHT_I2C_ADDRESS);
        if (climate_error == ESP_OK) climate_error = espemu_bme280_read(&climate, &environment);
        if (light_error == ESP_OK) light_error = espemu_bh1750_read(&ambient, &lux);
        climate_ready = climate_error == ESP_OK;
        ambient_ready = light_error == ESP_OK;
        esp_err_t outside_error = ESP_ERR_NOT_SUPPORTED;
#ifdef OUTSIDE_I2C_ADDRESS
        outside_error = espemu_tmp105_read(&outside, &outside_c);
#endif
        const unsigned presses = ulTaskNotifyTake(pdTRUE, 0);
        acknowledgements += presses;
        if (climate_ready) {
            if (environment.temperature_c <= 28 && environment.humidity_pct <= 65) {
                alarm = false;
                muted = false;
            } else {
                if (environment.temperature_c >= 30 || environment.humidity_pct >= 70) alarm = true;
                if (alarm && presses) muted = true;
            }
        }
        if (ambient_ready) {
            if (lux <= 50) night = true;
            if (lux >= 80) night = false;
        }
        const bool signal = climate_ready && alarm && !muted;
        const bool fault = !climate_ready || !ambient_ready || (outside_error != ESP_OK && outside_error != ESP_ERR_NOT_SUPPORTED);
        gpio_set_level(ALARM_PIN, signal ? ALARM_ACTIVE_LEVEL : !ALARM_ACTIVE_LEVEL);
        gpio_set_level(NIGHT_PIN, night && ambient_ready ? NIGHT_ACTIVE_LEVEL : !NIGHT_ACTIVE_LEVEL);
        gpio_set_level(SENSOR_FAULT_PIN, fault ? SENSOR_FAULT_ACTIVE_LEVEL : !SENSOR_FAULT_ACTIVE_LEVEL);
        char climate_text[24] = "null", lux_text[24] = "null", outside_text[24] = "null";
        if (climate_ready) snprintf(climate_text, sizeof(climate_text), "%.2f", environment.temperature_c);
        if (ambient_ready) snprintf(lux_text, sizeof(lux_text), "%.2f", lux);
        if (outside_error == ESP_OK) snprintf(outside_text, sizeof(outside_text), "%.2f", outside_c);
        printf("ESP_EMU {\"v\":1,\"seq\":%u,\"channels\":{"
               "\"climate\":{\"value\":%s,\"unit\":\"C\"},\"light\":{\"value\":%s,\"unit\":\"lx\"},"
               "\"outside\":{\"value\":%s,\"unit\":\"C\"},\"alarm_decision\":{\"value\":%d},"
               "\"acknowledgements\":{\"value\":%u},\"climate_error\":{\"value\":%d},"
               "\"light_error\":{\"value\":%d},\"outside_error\":{\"value\":%d}}}\n",
               sequence++, climate_text, lux_text, outside_text, signal, acknowledgements, climate_error, light_error, outside_error);
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}