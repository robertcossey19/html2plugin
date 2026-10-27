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
    FetchContent_Declare(JUCE GIT_REPOSITORY https://github.com/juce-framework/JUCE.git GIT_TAG 8.0.15 GIT_SHALLOW TRUE)
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
    Source/WebZoom.mm
    Source/JSHost.cpp)
set_source_files_properties(Source/WebZoom.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
target_link_libraries(${H2P_TARGET} PRIVATE "-framework WebKit")

target_compile_definitions(${H2P_TARGET} PUBLIC
    H2P_TARGET_NAME="${H2P_TARGET}"
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
# JavaScript engine for the DSP. Apple's system JavaScriptCore only JIT-compiles inside processes that carry the
# com.apple.security.cs.allow-jit entitlement (WebKit: isJITEnabled() under MAC_JIT_RESTRICTIONS). Plugin hosts do not
# carry it (Logic's AUHostingService XPC, Cubase, ...), so the system framework runs the worklet in its interpreter —
# 5-20x slower. A statically linked open-source JSC (bun-webkit prebuilt) has no such check: it JITs wherever MAP_JIT
# memory is available (allow-unsigned-executable-memory, which plugin hosts do carry), and JSHost falls back to the
# interpreter when it is not.
set(H2P_JSC_DIR "" CACHE PATH "prebuilt static JavaScriptCore dir (lib/libJavaScriptCore.a, libWTF.a, libbmalloc.a + include/); empty = system framework")
if(APPLE)
    if(H2P_JSC_DIR AND EXISTS "${H2P_JSC_DIR}/lib/libJavaScriptCore.a")
        message(STATUS "html2plugin: static JavaScriptCore from ${H2P_JSC_DIR} (JIT independent of the host's allow-jit entitlement)")
        target_include_directories(${H2P_TARGET} BEFORE PRIVATE "${H2P_JSC_DIR}/include")
        target_compile_definitions(${H2P_TARGET} PRIVATE H2P_STATIC_JSC=1 JSC_OBJC_API_ENABLED=0)
        target_sources(${H2P_TARGET} PRIVATE Source/JSCEmbedderStubs.cpp Source/WTFTLSGuard.cpp)
        set_source_files_properties(Source/WTFTLSGuard.cpp PROPERTIES COMPILE_FLAGS "-fno-lto")   # must stay a plain object so its _pthread_key_init_np wins over libSystem at link
        target_link_libraries(${H2P_TARGET} PRIVATE
            "${H2P_JSC_DIR}/lib/libJavaScriptCore.a" "${H2P_JSC_DIR}/lib/libWTF.a" "${H2P_JSC_DIR}/lib/libbmalloc.a"
            "${H2P_JSC_DIR}/lib/libmimalloc.a"
            icucore "-framework Foundation" "-framework CoreFoundation" "-framework Security")
        # keep the bundled engine private: the host process also maps Apple's JavaScriptCore.framework (through WebKit)
        target_link_options(${H2P_TARGET} INTERFACE
            "LINKER:-unexported_symbols_list,${CMAKE_CURRENT_SOURCE_DIR}/Source/jsc-unexported.txt"
            # embedder table lives in our archive, which the linker visits before the engine: force the object in
            "LINKER:-u,_h2p_jsc_embedder_stubs_anchor" "LINKER:-u,_Bun__removableFeatureState"
            # Bun-only hooks the engine references weakly (null => WTF uses its generic run loop); ld64 needs told they may stay undefined
            "LINKER:-U,_WTFTimer__create" "LINKER:-U,_WTFTimer__update" "LINKER:-U,_WTFTimer__deinit" "LINKER:-U,_WTFTimer__isActive"
            "LINKER:-U,_WTFTimer__secondsUntilTimer" "LINKER:-U,_WTFTimer__cancel" "LINKER:-U,_Bun__thisThreadHasVM" "LINKER:-U,_Bun__reportUnhandledError")
    else()
        message(STATUS "html2plugin: system JavaScriptCore.framework (interpreter-only in hosts without allow-jit)")
        target_link_libraries(${H2P_TARGET} PRIVATE "-framework JavaScriptCore")
    endif()
endif()

# ---- HostTest: loads the built VST3 in a real JUCE host, checks parameters/state/levels and the golden master ----
option(H2P_BUILD_HOSTTEST "Build the host test" ON)
if(H2P_BUILD_HOSTTEST)
    juce_add_console_app(${H2P_TARGET}HostTest PRODUCT_NAME "${H2P_TARGET}HostTest")
    target_sources(${H2P_TARGET}HostTest PRIVATE HostTest/main.cpp HostTest/WebSnapshot.mm)
    set_source_files_properties(HostTest/WebSnapshot.mm PROPERTIES COMPILE_FLAGS "-fobjc-arc")
    target_link_libraries(${H2P_TARGET}HostTest PRIVATE "-framework WebKit")
    target_compile_definitions(${H2P_TARGET}HostTest PRIVATE JUCE_PLUGINHOST_VST3=1 JUCE_PLUGINHOST_AU=1 JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_MODAL_LOOPS_PERMITTED=1 H2P_TARGET_NAME="${H2P_TARGET}")
    target_link_libraries(${H2P_TARGET}HostTest PRIVATE ${H2P_TARGET}Data juce::juce_audio_utils juce::juce_audio_processors juce::juce_gui_extra PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)
endif()
