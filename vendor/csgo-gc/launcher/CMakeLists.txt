project(launcher)

# messy
function(launcher_target NAME DEDICATED)
    if (WIN32)
        add_executable(${NAME} WIN32 launcher_win.cpp launcher.rc)
    else()
        add_executable(${NAME} launcher_unix.cpp)
    endif()
    
    set_target_properties(${NAME} PROPERTIES OUTPUT_NAME ${NAME}${GC_EXE_SUFFIX})
    
    if (MSVC)
        # we need large address awareness and a larger stack to not crash
        target_link_options(${NAME} PRIVATE /LARGEADDRESSAWARE /STACK:1572864)
    endif()
    
    # apple message box
    if (APPLE)
        target_link_libraries(${NAME} PRIVATE "-framework Foundation")
    endif()

    if (DEDICATED)
        target_compile_definitions(${NAME} PRIVATE DEDICATED)
    endif()
    
    target_compile_definitions(${NAME} PRIVATE
        GC_LIB_DIR="${GC_LIB_DIR}"
        GC_LIB_SUFFIX="${GC_LIB_SUFFIX}"
        GC_LIB_EXTENSION="${CMAKE_SHARED_LIBRARY_SUFFIX}")
    
    if (OUTDIR)
        add_custom_command(TARGET ${NAME} POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy
            $<TARGET_FILE:${NAME}>
            ${OUTDIR}/$<TARGET_FILE_NAME:${NAME}>)
    endif()
endfunction()

launcher_target(csgo OFF)

if (WIN32 OR (IS_32BIT AND NOT APPLE))
    launcher_target(srcds ON)
endif()

if (WIN32 AND BUILD_TESTING)
    # Deliberately use the conflicting Windows DLL basename. The consumer has
    # an export dependency absent from the system DLL, reproducing error 127.
    add_library(icu_fixture_common SHARED client_runtime_fixture.cpp)
    add_library(icu_fixture_consumer SHARED client_runtime_fixture.cpp)
    target_compile_definitions(icu_fixture_consumer PRIVATE ICU_FIXTURE_CONSUMER)
    target_link_libraries(icu_fixture_consumer PRIVATE icu_fixture_common)
    set_target_properties(icu_fixture_common PROPERTIES OUTPUT_NAME icuuc RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/icu_fixture")
    set_target_properties(icu_fixture_consumer PROPERTIES OUTPUT_NAME icui18n RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/icu_fixture")
    add_executable(client_runtime_tests client_runtime_tests.cpp)
    add_dependencies(client_runtime_tests icu_fixture_consumer)
    add_test(NAME client_runtime_load COMMAND client_runtime_tests "$<TARGET_FILE_DIR:icu_fixture_common>" complete)
    add_test(NAME client_runtime_missing COMMAND client_runtime_tests "${CMAKE_CURRENT_BINARY_DIR}/no_runtime" missing)
endif()
