// Freestanding NDK machine-code test. No libc, allocator, pthread, JNI, worker
// or TLS runtime can be linked. QEMU executes a fresh process per scenario.
// Only OS thread-register setup and deterministic clocks are test adapters.
#include "../../modules/startup-diagnostics/native/SchedulingCore.h"
using namespace kinnship78;
extern "C" {
#if defined(__aarch64__)
// CPU/OS adapter: select the compiler-rt ARMv8.0 LL/SC path. The ACTUAL NDK
// outlined-atomic assembly is linked below, not replaced with a test CAS.
// On Android its CPU feature byte is set at library load, not first producer.
char __aarch64_have_lse_atomics=0;
#endif
void* memset(void* p,int c,size_t n) {
  auto* d=static_cast<volatile unsigned char*>(p);
  for(size_t i=0;i<n;++i)d[i]=c; return p;
}
void* memcpy(void* p,const void* q,size_t n) {
  auto* d=static_cast<volatile unsigned char*>(p);
  auto* s=static_cast<const volatile unsigned char*>(q);
  for(size_t i=0;i<n;++i)d[i]=s[i]; return p;
}
void* memmove(void* p,const void* q,size_t n) {
  auto* d=static_cast<volatile unsigned char*>(p);
  auto* s=static_cast<const volatile unsigned char*>(q);
  if(d<s)for(size_t i=0;i<n;++i)d[i]=s[i];
  else for(size_t i=n;i;--i)d[i-1]=s[i-1]; return p;
}
int clock_gettime(clockid_t, timespec* t) { t->tv_sec=1; t->tv_nsec=2; return 0; }
void __aeabi_memcpy(void* d,const void* s,size_t n) { memcpy(d,s,n); }
void __aeabi_memcpy4(void* d,const void* s,size_t n) { memcpy(d,s,n); }
void __aeabi_memcpy8(void* d,const void* s,size_t n) { memcpy(d,s,n); }
void __aeabi_memclr(void* d,size_t n) { memset(d,0,n); }
void __aeabi_memclr4(void* d,size_t n) { memset(d,0,n); }
void __aeabi_memclr8(void* d,size_t n) { memset(d,0,n); }
}
static long raw(long nr,long a=0,long b=0,long c=0) {
#if defined(__x86_64__)
  long result;
  __asm__ volatile("syscall":"=a"(result):"a"(nr),"D"(a),"S"(b),"d"(c):"rcx","r11","memory");
  return result;
#elif defined(__i386__)
  long result;
  __asm__ volatile("int $0x80":"=a"(result):"a"(nr),"b"(a),"c"(b),"d"(c):"memory");
  return result;
#elif defined(__aarch64__)
  register long x8 __asm__("x8")=nr;
  register long x0 __asm__("x0")=a;
  register long x1 __asm__("x1")=b;
  register long x2 __asm__("x2")=c;
  __asm__ volatile("svc 0":"+r"(x0):"r"(x8),"r"(x1),"r"(x2):"memory"); return x0;
#elif defined(__arm__)
  register long r7 __asm__("r7")=nr;
  register long r0 __asm__("r0")=a;
  register long r1 __asm__("r1")=b;
  register long r2 __asm__("r2")=c;
  __asm__ volatile("svc 0":"+r"(r0):"r"(r7),"r"(r1),"r"(r2):"memory"); return r0;
#endif
}
[[noreturn]] static void finish(int status) {
#if defined(__aarch64__)
  raw(93,status);
#elif defined(__x86_64__)
  raw(60,status);
#else
  raw(1,status);
#endif
  __builtin_trap();
}
static void verify(bool value,int code) { if(!value)finish(code); }
alignas(64) static uintptr_t tcbs[localCapacity+1][8];
#if defined(__i386__)
static unsigned descriptorEntry=~0u;
#endif
static void setThread(size_t index) {
  auto address=reinterpret_cast<uintptr_t>(&tcbs[index]);
  tcbs[index][0]=address;
#if defined(__aarch64__)
  __asm__ volatile("msr tpidr_el0, %0"::"r"(address):"memory");
#elif defined(__arm__)
  verify(raw(0xf0005,address)==0,11);
#elif defined(__x86_64__)
  verify(raw(158,0x1002,address)==0,11); // Linux arch_prctl(SET_FS)
#elif defined(__i386__)
  struct Descriptor { unsigned entry,base,limit,flags; } descriptor{descriptorEntry,unsigned(address),0xfffff,0x51};
  verify(raw(243,reinterpret_cast<uintptr_t>(&descriptor))==0,11);
  descriptorEntry=descriptor.entry;
  unsigned selector=(descriptor.entry<<3)|3;
  __asm__ volatile("movw %w0, %%gs"::"r"(selector):"memory");
#endif
}
static size_t owned() { size_t n=0; for(auto& o:localOwners)if(o.load())++n; return n; }
// The OS adapter switches logical thread registers only between calls. Prevent
// the compiler from assuming one thread pointer for the entire fixture entry;
// real production threads never switch their register inside a function.
__attribute__((noinline)) static void heldCaller() { hold(); publish(stamp(Host)); }
__attribute__((noinline)) static void releasedCaller() { release(); }
__attribute__((noinline)) static void failedCaller() { hold(); }
extern "C" [[noreturn]] void cold_entry(uintptr_t* startup) {
  const char* argument=startup[0]>1?reinterpret_cast<const char*>(startup[2]):"early";
  const char mode=argument[0]=='e' && argument[1]=='x'?'x':argument[0];
#if defined(__aarch64__)
  if(mode=='l')__aarch64_have_lse_atomics=1; // second fresh image, LSE-capable CPU
#endif
  setThread(0); // OS adapter, not recorder initialization or warming
  if(mode=='e') {
    hold(); // genuinely FIRST observer use; ready is still false
    { RuntimeScope scope(7); ProgressGuard p(1); publish(stamp(Host)); }
    release();
    verify(!ready.load() && initialization.load()==0,21);
    verify(owned()==0 && ingress.write.load()==0,22);
  } else {
    initialize(); // only the independent ingress lifecycle; no local-pool access
    if(mode=='x') {
      for(size_t i=0;i<localCapacity;++i){setThread(i);heldCaller();}
      setThread(localCapacity); failedCaller();
      verify(contextClosed.load() && contextExhaustions.load()==1,23);
      for(size_t i=0;i<localCapacity;++i){setThread(i);releasedCaller();}
      setThread(localCapacity); publish(stamp(Host)); release();
      verify(owned()==0 && ingress.write.load()==0,24);
    } else if(mode=='p') {
      publish(stamp(Host));
      Event row; verify(ingress.poll(row) && row.stage==Host && owned()==0,25);
    } else {
      Event e; e.request[0]='a';
      if(mode=='h') hold(); // first-use deferred admission
      {
        RuntimeScope runtime(7); // first-use context in mode 'r'
        auto registration=begin(e);
        selected(7,42); admitted(11,42,8000); end(registration,42);
        timer(Submit,7,11,42); timer(RuntimeEnter,7,11,42); callback(registration);
      }
      if(mode=='h'){verify(ingress.write.load()==0,26);release();}
      Event row; int stages[]={8,11,9,15,16,17}; int n=0;
      while(ingress.poll(row)){
        verify(n<6 && row.stage==stages[n] && row.runtime==7 && row.request[0]=='a',27);
        ++n;
      }
      verify(n==6 && owned()==0 && !contextClosed.load(),28);
    }
  }
  finish(0);
}
#if defined(__x86_64__)
__asm__(".global _start\n_start:\nmov %rsp,%rdi\nandq $-16,%rsp\ncall cold_entry\nud2\n");
#elif defined(__i386__)
__asm__(".global _start\n_start:\nmov %esp,%eax\nandl $-16,%esp\nsubl $12,%esp\npush %eax\ncall cold_entry\nud2\n");
#elif defined(__aarch64__)
__asm__(".global _start\n_start:\nmov x0,sp\nbl cold_entry\nbrk #0\n");
#elif defined(__arm__)
__asm__(".global _start\n.arm\n_start:\nmov r0,sp\nbl cold_entry\nudf #0\n");
#endif
