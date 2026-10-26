# html2plugin generic runtime — JUCE 8 plugin that runs the original page's AudioWorklet inside JavaScriptCore
# and shows the original HTML as its GUI. Per-plugin values come from plugin.cmake (written by the forge).
cmake_minimum_required(VERSION 3.22)
include(${CMAKE_CURRENT_SOURCE_DIR}/plugin.cmake)
string(MAKE_C_IDENTIFIER "${H2P_SLUG}" H2P_TARGET)
project(${H2P_TARGET} VERSION ${H2P_VERSION} LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "")

set(PLUGIN_CODESIGN_IDENTITY "-" CACHE STRING "codesign identity ('-' = ad-hoc)")
set(PLUGIN_DEVELOPMENT_TEAM "" CACHE STRING "Apple Team ID")
set(CMAKE_XCODE_ATTRIBUTE_CODE_SIGN_IDENTITY "${PLUGIN_CODESIGN_IDENTITY}")
set(CMAKE_XCODE_ATTRIBUTE_DEVELOPMENT_TEAM "${PLUGIN_DEVELOPMENT_TEAM}")
set(CMAKE_XCODE_ATTRIBUTE_CODE_SIGN_STYLE "Manual")

set(JUCE_BUILD_EXTRAS OFF CACHE BOOL "" FORCE)
set(JUCE_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/JUCE/CMakeLists.txt")
    add_subdirectory(JUCE)
else()
    include(FetchContent)
    FetchContent_Declare(JUCE GIT_REPOSITORY https://github.com/juce-framework/JUCE.git GIT_TAG 8.0.4 GIT_SHALLOW TRUE)
    FetchContent_MakeAvailable(JUCE)
endif()

set(FORMATS VST3 Standalone)
if(APPLE)
    list(APPEND FORMATS AU)
endif()

juce_add_plugin(${H2P_TARGET}
    PRODUCT_NAME "${H2P_NAME}"
    COMPANY_NAME "${H2P_VENDOR}"
    BUNDLE_ID "${H2P_BUNDLE_ID}"
    PLUGIN_MANUFACTURER_CODE ${H2P_MANU_CODE}
    PLUGIN_CODE ${H2P_PLUGIN_CODE}
    FORMATS ${FORMATS}
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS TRUE
    COPY_PLUGIN_AFTER_BUILD FALSE
    VST3_CATEGORIES Fx
    AU_MAIN_TYPE kAudioUnitType_Effect
    NEEDS_WEB_BROWSER TRUE
    HARDENED_RUNTIME_ENABLED TRUE
    HARDENED_RUNTIME_OPTIONS "com.apple.security.cs.allow-jit;com.apple.security.cs.allow-unsigned-executable-memory")

# Everything the plugin needs ships inside the binary: original page, engine, shim, worklet module(s), manifest.
juce_add_binary_data(${H2P_TARGET}Data SOURCES
    Assets/index.html Assets/engine.js Assets/shim.js Assets/worklets.js Assets/manifest.json)
set_target_properties(${H2P_TARGET}Data PROPERTIES POSITION_INDEPENDENT_CODE ON)

target_sources(${H2P_TARGET} PRIVATE
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp
    Source/JSHost.cpp)

target_compile_definitions(${H2P_TARGET} PUBLIC
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0)

target_link_libraries(${H2P_TARGET} PRIVATE
    ${H2P_TARGET}Data
    juce::juce_audio_utils
    juce::juce_gui_extra
    PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags)
if(APPLE)
    target_link_libraries(${H2P_TARGET} PRIVATE "-framework JavaScriptCore")
endif()

# ---- HostTest: loads the built VST3 in a real JUCE host, checks parameters/state/levels and the golden master ----
option(H2P_BUILD_HOSTTEST "Build the host test" ON)
if(H2P_BUILD_HOSTTEST)
    juce_add_console_app(${H2P_TARGET}HostTest PRODUCT_NAME "${H2P_TARGET}HostTest")
    target_sources(${H2P_TARGET}HostTest PRIVATE HostTest/main.cpp)
    target_compile_definitions(${H2P_TARGET}HostTest PRIVATE JUCE_PLUGINHOST_VST3=1 JUCE_PLUGINHOST_AU=1 JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_MODAL_LOOPS_PERMITTED=1 H2P_TARGET_NAME="${H2P_TARGET}")
    target_link_libraries(${H2P_TARGET}HostTest PRIVATE ${H2P_TARGET}Data juce::juce_audio_utils juce::juce_audio_processors juce::juce_gui_extra PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)
endif()
