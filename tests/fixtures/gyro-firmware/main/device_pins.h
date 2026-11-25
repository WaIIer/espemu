#pragma once
#include "driver/gpio.h"
#include "driver/i2c.h"
#define MOTION_BUS_SDA_PIN GPIO_NUM_21
#define MOTION_BUS_SCL_PIN GPIO_NUM_22
#define MOTION_I2C_PORT I2C_NUM_0
#define MOTION_I2C_ADDRESS 0x68
#define INDICATOR_PIN GPIO_NUM_2
