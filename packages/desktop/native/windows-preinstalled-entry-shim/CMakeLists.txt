cmake_minimum_required(VERSION 3.21)

cmake_policy(SET CMP0091 NEW)
project(zcode_preinstalled_entry_shim LANGUAGES C)

if(NOT MSVC)
  message(FATAL_ERROR "ZCode preinstalled entry shim must be built with MSVC")
endif()
if(NOT DEFINED ZCODE_SHIM_OUTPUT_DIR)
  message(FATAL_ERROR "Missing ZCODE_SHIM_OUTPUT_DIR")
endif()

# 静态链接 C 运行库：shim 复制到预装 bin 目录后独立运行，不依赖目标机器的 VC++ 运行库。
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(zcode-preinstalled-entry-shim shim.c)
target_compile_definitions(zcode-preinstalled-entry-shim PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN)
# /Brepro 去掉时间戳，同一源码产出相同字节；入口是否需要替换按 SHA-256 判断。
target_compile_options(zcode-preinstalled-entry-shim PRIVATE /W4 /WX /utf-8 /guard:cf /Brepro)
target_link_options(zcode-preinstalled-entry-shim PRIVATE /GUARD:CF /Brepro /SUBSYSTEM:CONSOLE)
set_target_properties(zcode-preinstalled-entry-shim PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${ZCODE_SHIM_OUTPUT_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${ZCODE_SHIM_OUTPUT_DIR}"
)
