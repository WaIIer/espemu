cmake_minimum_required(VERSION 3.16)
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/../../../components/espemu_devices" "${CMAKE_CURRENT_LIST_DIR}/../../../firmware/components/bme280")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(device_sdk_test)
