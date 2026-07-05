cmake_minimum_required(VERSION 3.20)

project(openscreen-ctranslate2-server LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ponytail: CTranslate2's C++ library is built standalone (the Python wheel is a
# separate, optional step). Pin the upstream ref in one place so a release
# maintainer only edits here — see docs/engineering/stt-ctranslate2-migration.md
# § Decision. CUDA support is opt-in via -DENABLE_CUDA=ON; the goal-pursue
# baseline (this commit) builds CPU-only because that's the mat that actually
# compiles on a stock Windows / Linux host without a CUDA SDK.
set(CTRANS2_REPO "https://github.com/OpenNMT/CTranslate2.git" CACHE STRING "CTranslate2 git URL")
set(CTRANS2_REF  "v4.4.0" CACHE STRING "CTranslate2 ref/tag/branch")
set(ENABLE_CUDA  OFF CACHE BOOL "Build CTranslate2 + server with CUDA")
option(WITH_MKL "Use Intel MKL backend (Linux/macOS only; OFF on Windows)" OFF)
option(WITH_OPENBLAS "Use OpenBLAS backend" ON)
# ponytail: CTranslate2 pulls a fair amount of binary under FetchContent
# (Intel MKL/oneDNN, Intel MKL-DNN is ~80 MB alone). Disable it. On Windows we
# drop BLAS entirely — CTranslate2 still runs without an external BLAS, just
# slower; the goal-pursue build here is "compiles and answers the test",
# benchmarks come later.
if(WIN32)
  set(WITH_BLAS_DEFAULT OFF)
else()
  set(WITH_BLAS_DEFAULT ON)
endif()
option(WITH_BLAS "Build CTranslate2 with a BLAS backend (oneDNN/MKL/OpenBLAS)" ${WITH_BLAS_DEFAULT})

include(FetchContent)
set(FETCHCONTENT_QUIET OFF)
FetchContent_Declare(
  ctranslate2
  GIT_REPOSITORY ${CTRANS2_REPO}
  GIT_TAG        ${CTRANS2_REF}
  GIT_SHALLOW    TRUE
  GIT_SUBMODULES_RECURSE TRUE
)
FetchContent_Declare(
  httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG        v0.18.1
  GIT_SHALLOW    TRUE
)
FetchContent_Declare(
  json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG        v3.11.3
  GIT_SHALLOW    TRUE
)

set(CTRANS2_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(CTRANS2_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CTRANS2_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(CTRANS2_BUILD_PYTHON OFF CACHE BOOL "" FORCE)
set(CTRANS2_CPU_ONLY OFF CACHE BOOL "" FORCE)
set(CTRANS2_INSTALL OFF CACHE BOOL "" FORCE)
set(CTRANS2_SHARED_LIB OFF CACHE BOOL "" FORCE)
set(CTRANS2_STATIC_LIB ON CACHE BOOL "" FORCE)
set(CTRANS2_WITH_MKL OFF CACHE BOOL "" FORCE)
set(CTRANS2_WITH_DNNL OFF CACHE BOOL "" FORCE)
set(CTRANS2_WITH_ACCELERATE OFF CACHE BOOL "" FORCE)
set(CTRANS2_WITH_OPENBLAS OFF CACHE BOOL "" FORCE)
# ponytail: Ruy is the only bundled CPU GEMM backend that doesn't pull in a
# system BLAS — it ships a portable kernel that works on stock Windows
# without any oneAPI/MKL/OpenBLAS installs. Without it, fp16 inference on
# CPU throws "No SGEMM backend on CPU" the moment we try to call into the
# decoder — confirmed empirically on 2026-07-05. Ruy only supports fp32 +
# int8; we lose fp16 perf but keep the no-deps binary layout.
set(CTRANS2_WITH_RUY ON CACHE BOOL "" FORCE)
set(CTRANS2_WITH_BLAS OFF CACHE BOOL "" FORCE)
set(CTRANS2_OPENMP_RUNTIME "NONE" CACHE STRING "" FORCE)
set(CTRANS2_BUILD_CLI OFF CACHE BOOL "" FORCE)
set(CTRANS2_WITH_CUDA OFF CACHE BOOL "" FORCE)
set(CTRANS2_WITH_TENSOR_PARALLEL OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(ctranslate2 httplib json)

add_executable(ctranslate2-server
  src/main.cpp
  src/mel.cpp
)
target_include_directories(ctranslate2-server PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/include
  ${CMAKE_CURRENT_SOURCE_DIR}
)
target_link_libraries(ctranslate2-server PRIVATE
  ctranslate2
  httplib::httplib
  nlohmann_json::nlohmann_json
)
# ponytail: compile the vendored KissFFT .c alongside our own sources.
# Public-domain BSD-3-Clause code lives at third_party/kissfft/.
target_sources(ctranslate2-server PRIVATE
  third_party/kissfft/kiss_fft.c
)

if(WIN32)
  target_compile_definitions(ctranslate2-server PRIVATE
    NOMINMAX WIN32_LEAN_AND_MEAN _WIN32_WINNT=0x0A00
  )
  set_target_properties(ctranslate2-server PROPERTIES WIN32_EXECUTABLE OFF)
endif()
