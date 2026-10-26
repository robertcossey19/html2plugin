// Only compiled when the plugin links the static open-source JavaScriptCore (bun-webkit prebuilt, see CMakeLists.txt).
// That build expects its embedder to provide the "removable feature" table (Bun trims unused engine features out of
// its own binary). We trim nothing: isTrimmed = 0 means every guarded path stays live and the throw hooks are never reached.
#include <cstdint>
#include <cstdlib>

extern "C" {

struct H2PRemovableFeatureState {              // mirrors JSC's RemovableFeatureState: sizeof == 536, removal[] at offset 24
    uint8_t magic[8];
    uint32_t isTrimmed;
    uint32_t removedRangeCount;
    int64_t removedRangesOffset;
    uint8_t removal[512];
};
static_assert (sizeof (H2PRemovableFeatureState) == 536, "layout must match JavaScriptCore/AOTRemovableFeature.h");

__attribute__((visibility("hidden"))) const H2PRemovableFeatureState Bun__removableFeatureState = {};

__attribute__((visibility("hidden"), noreturn)) void Bun__abortForRemovedFeature (uint16_t) { abort(); }
__attribute__((visibility("hidden"))) uint64_t Bun__throwForRemovedFeature (void*, uint16_t) { return 0; }
__attribute__((visibility("hidden"))) uint64_t Bun__throwForRemovedBuiltin (void*, uint16_t, uint32_t) { return 0; }
__attribute__((visibility("hidden"))) uint64_t Bun__throwForRemovedFunction (void*, uint16_t, void*) { return 0; }

}
