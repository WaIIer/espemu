#include "device_pins.h"

/* Alternates 440 Hz and 880 Hz tones and shows the current note on the LCD. */
void app_main(void)
{
    ESP_ERROR_CHECK(espemu_i2c_init(I2C0_I2C_PORT, I2C0_SDA_PIN, I2C0_SCL_PIN, 100000));
    espemu_hd44780_t lcd;
    ESP_ERROR_CHECK(espemu_hd44780_init(&lcd, LCD_I2C_PORT, LCD_I2C_ADDRESS, LCD_COLUMNS, LCD_ROWS));
    const uint8_t note[8] = {0x02, 0x03, 0x02, 0x02, 0x0e, 0x1e, 0x0c, 0x00};
    ESP_ERROR_CHECK(espemu_hd44780_create_char(&lcd, 1, note));
    ESP_ERROR_CHECK(espemu_hd44780_print(&lcd, "ESPEmu jukebox "));
    ESP_ERROR_CHECK(espemu_hd44780_write_char(&lcd, 1));
    i2s_chan_handle_t speaker;
    ESP_ERROR_CHECK(espemu_max98357a_init(&speaker, SPEAKER_BCLK_PIN, SPEAKER_LRCLK_PIN, SPEAKER_DIN_PIN, 16000));
    static const uint32_t notes[] = {440, 880};
    for (unsigned count = 0;; count++) {
        uint32_t frequency = notes[count % 2];
        ESP_ERROR_CHECK(espemu_hd44780_printf(&lcd, 0, 1, "Playing %lu Hz", (unsigned long)frequency));
        ESP_ERROR_CHECK(espemu_hd44780_printf(&lcd, 0, 3, "Tones %u", count + 1));
        printf("TONE %lu\n", (unsigned long)frequency);
        ESP_ERROR_CHECK(espemu_max98357a_tone(speaker, 16000, frequency, 1000, 12000));
    }
}
