cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(espemu)
include("${CMAKE_CURRENT_LIST_DIR}/.espemu-device-sdk.cmake" OPTIONAL)
