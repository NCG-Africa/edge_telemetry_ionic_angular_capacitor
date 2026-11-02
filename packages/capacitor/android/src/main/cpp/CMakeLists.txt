# Spec E12: libedge-rum-native.so, the NDK signal handler (native-crash.c).
cmake_minimum_required(VERSION 3.22.1)
project(edge-rum-native LANGUAGES C)
add_library(edge-rum-native SHARED native-crash.c)
target_link_libraries(edge-rum-native dl)
