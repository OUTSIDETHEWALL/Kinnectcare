// Deliberately unsafe NEGATIVE CONTROL, never application source.
#include <cstdint>
struct UnsafeControl { uint64_t depth=0; char scratch[2048]{}; };
static thread_local UnsafeControl unsafe;
extern "C" uint64_t unsafe_first_use() { return ++unsafe.depth; }
