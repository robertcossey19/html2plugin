// Keeps the bundled engine's per-thread bookkeeping out of Apple's hands (and vice versa).
//
// Both copies of WTF in this process — Apple's (JavaScriptCore.framework, mapped by WebKit for the editor and by most
// DAWs anyway) and the one linked into this binary — store their WTF::Thread object in the same fixed pthread TSD slot,
// __PTK_FRAMEWORK_JAVASCRIPTCORE_KEY2 (= 92, wtf/FastTLS.h), and register a thread-exit destructor for that slot with
// pthread_key_init_np(92, &Thread::destructTLS). libpthread keeps ONE destructor per key for the whole process and the
// first registration wins (pthread_tsd.c: _pthread_key_set_destructor returns false once set). So in any process where
// WebKit came up first, every one of OUR threads that exits — the warm-up thread, JIT worklist and GC helper threads that
// idle out, the sampler — has Apple's destructTLS run over OUR Thread object: wrong struct layout, wrong allocator,
// a stray deref/delete. That is the memory corruption behind the random RELEASE_ASSERTs in Heap::collect (atom table
// mismatch), the stack-smash in build 37 and the 192 kHz init hang. The same happens the other way round in a process
// where we initialise first and Apple's threads exit.
//
// Fix: the engine's reference to pthread_key_init_np binds here (an object-file definition beats the libsystem export at
// link time; the static archive's undefined _pthread_key_init_np resolves to this one). For slot 92 we never touch the
// process-global destructor. Instead each engine thread's Thread object is also parked in a private dynamic key whose
// destructor runs the engine's own destructTLS protocol (two passes, exactly as libpthread would) and then clears slot 92
// so Apple's destructor — which libpthread runs after the dynamic keys (_pthread_tsd_cleanup_new: dynamic first, then the
// static range, in every iteration) — finds nothing on our threads. Apple's threads never carry our object, so the global
// destructor Apple registered stays correct for them.
#if H2P_STATIC_JSC
#include <pthread.h>
#include <dlfcn.h>
#include <errno.h>
#include <mutex>
#if __has_include(<pthread/tsd_private.h>)
 #include <pthread/tsd_private.h>
 #define H2P_TSD_DIRECT 1
#else
 #define H2P_TSD_DIRECT 0
#endif

namespace
{
    constexpr int kWTFThreadDataKey = 92;   // __PTK_FRAMEWORK_JAVASCRIPTCORE_KEY2 == WTF_THREAD_DATA_KEY
    pthread_key_t gPrivateKey {};
    std::once_flag gPrivateKeyOnce;
    void (*gEngineDestructor) (void*) = nullptr;

    inline void* slotGet()
    {
       #if H2P_TSD_DIRECT
        return _pthread_getspecific_direct (kWTFThreadDataKey);
       #else
        return pthread_getspecific ((pthread_key_t) kWTFThreadDataKey);
       #endif
    }
    inline void slotSet (void* v)
    {
       #if H2P_TSD_DIRECT
        _pthread_setspecific_direct (kWTFThreadDataKey, v);
       #else
        pthread_setspecific ((pthread_key_t) kWTFThreadDataKey, v);
       #endif
    }

    // Runs on exit of a thread the bundled engine initialised (libpthread has already nulled our private slot).
    void privateDestructor (void* thread)
    {
        auto* d = gEngineDestructor;
        if (thread == nullptr || d == nullptr) return;
        if (slotGet() != thread) return;   // slot no longer carries our object: leave whatever is there alone
        // Pass 1 (WTF: marks m_isDestroyedOnce, re-arms the slot + calls pthread_key_init_np -> we re-park it below, then
        // destroys the thread's ClientData while Thread::current() still works). Pass 2: didExit() + deref().
        d (thread);
        d (thread);
        slotSet (nullptr);
        pthread_setspecific (gPrivateKey, nullptr);
    }
}

extern "C" int pthread_key_init_np (int key, void (*destructor) (void*))
{
    if (key == kWTFThreadDataKey)
    {
        std::call_once (gPrivateKeyOnce, [] { pthread_key_create (&gPrivateKey, privateDestructor); });
        if (destructor != nullptr) gEngineDestructor = destructor;
        pthread_setspecific (gPrivateKey, slotGet());   // the object the engine just stored in slot 92 on this thread
        return 0;
    }
    // Any other key (WTF only registers 92; bmalloc is built on the system allocator here): forward to libpthread.
    using Fn = int (*) (int, void (*) (void*));
    static Fn real = [] () -> Fn
    {
        void* h = dlopen ("/usr/lib/system/libsystem_pthread.dylib", RTLD_LAZY | RTLD_NOLOAD);
        void* s = h != nullptr ? dlsym (h, "pthread_key_init_np") : nullptr;
        if (s == nullptr) s = dlsym (RTLD_DEFAULT, "pthread_key_init_np");
        if (s == reinterpret_cast<void*> (&pthread_key_init_np)) s = nullptr;   // never recurse into ourselves
        return reinterpret_cast<Fn> (s);
    }();
    return real != nullptr ? real (key, destructor) : EINVAL;
}
#endif
