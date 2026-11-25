#include <stdlib.h>
#include "device_pins.h"
#include "img_converters.h"

/* Decodes each captured JPEG on the ESP32 and reports mean brightness of the left and right halves. */
void app_main(void)
{
    camera_config_t config = CAMERA_CAMERA_CONFIG(PIXFORMAT_JPEG, FRAMESIZE_QQVGA);
    ESP_ERROR_CHECK(esp_camera_init(&config));
    uint8_t *rgb = malloc(160 * 120 * 3);
    if (!rgb) abort();
    for (;;) {
        camera_fb_t *frame = esp_camera_fb_get();
        if (frame) {
            unsigned long left = 0, right = 0;
            bool decoded = fmt2rgb888(frame->buf, frame->len, frame->format, rgb);
            for (size_t y = 0; decoded && y < frame->height; y++)
                for (size_t x = 0; x < frame->width; x++) {
                    const uint8_t *pixel = &rgb[(y * frame->width + x) * 3];
                    unsigned value = pixel[0] + pixel[1] + pixel[2];
                    if (x < frame->width / 2) left += value; else right += value;
                }
            unsigned half = frame->width * frame->height / 2 * 3;
            printf("CAMERA %ux%u len=%u decoded=%d left=%lu right=%lu\n", (unsigned)frame->width, (unsigned)frame->height,
                   (unsigned)frame->len, decoded, left / half, right / half);
            esp_camera_fb_return(frame);
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
