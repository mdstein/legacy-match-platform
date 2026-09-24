#pragma once

#include <cstddef>
#include <cstdint>

enum class PanoramaPatchResult
{
    NotPanorama,
    Patched,
    Rejected,
};

PanoramaPatchResult PatchFinalPanoramaArchive(void *buffer, size_t size);

#ifdef PANORAMA_PATCH_TESTING
#include <array>

PanoramaPatchResult PatchPanoramaArchiveForTests(void *buffer, size_t size,
    const std::array<uint32_t, 10> &expectedCrcs);
uint32_t PanoramaPatchCrc32ForTests(const void *buffer, size_t size);
#endif
