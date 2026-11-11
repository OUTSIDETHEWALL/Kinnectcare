#include "../../modules/startup-diagnostics/native/SchedulingCore.h"
#include <cassert>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <thread>
#include <vector>
#include <cstring>
using namespace kinnship78;
// Test-only guard; never reads/initializes any recorder state.
static thread_local bool insideProducer = false;
static std::atomic<int> forbidden{0};
extern "C" {
void* __real_malloc(size_t); void* __real_calloc(size_t, size_t);
void* __real_realloc(void*, size_t); void __real_free(void*);
int __real_pthread_mutex_lock(pthread_mutex_t*);
int __real_pthread_once(pthread_once_t*, void (*)());
int __real_pthread_setspecific(pthread_key_t, const void*);
void* __wrap_malloc(size_t n) { if (insideProducer) ++forbidden; return __real_malloc(n); }
void* __wrap_calloc(size_t n, size_t s) { if (insideProducer) ++forbidden; return __real_calloc(n,s); }
void* __wrap_realloc(void* p, size_t n) { if (insideProducer) ++forbidden; return __real_realloc(p,n); }
void __wrap_free(void* p) { if (insideProducer) ++forbidden; __real_free(p); }
int __wrap_pthread_mutex_lock(pthread_mutex_t* p) { if (insideProducer) ++forbidden; return __real_pthread_mutex_lock(p); }
int __wrap_pthread_once(pthread_once_t* p, void (*f)()) { if (insideProducer) ++forbidden; return __real_pthread_once(p,f); }
int __wrap_pthread_setspecific(pthread_key_t p, const void* v) { if (insideProducer) ++forbidden; return __real_pthread_setspecific(p,v); }
}
static int checks;
static void verifyAt(bool value,int line) {
  if (!value) {
    std::cerr<<"FAIL line "<<line<<"; checks="<<checks<<"; bindings="<<bindingLoss.load()
      <<"; contention="<<bindingContention.load()<<"; contextLoss="<<contextLoss.load()
      <<"; forbidden="<<forbidden.load()<<"\n"; std::abort();
  }
  ++checks;
}
#define verify(value) verifyAt((value),__LINE__)
static size_t owned() {
  size_t n=0; for (auto& owner:localOwners) if (owner.load()) ++n; return n;
}
static Event request() {
  Event e; std::memset(e.request,'a',32); std::memset(e.operation,'b',32);
  std::memset(e.flight,'c',32); std::memset(e.js,'d',32); return e;
}
static void roundtrip() {
  RuntimeScope runtime(7);
  auto e=request(); auto registration=begin(e);
  selected(7,42); admitted(11,42,8000); end(registration,42);
  timer(Submit,7,11,42); timer(RuntimeEnter,7,11,42); callback(registration);
}
int main(int argc,char** argv) {
  verify(argc==2); const auto mode=argv[1];
  if (!std::strcmp(mode,"cold")) {
    verify(owned()==0 && !ready.load());
    std::mutex vendor;
    std::thread thread([&] {
      std::lock_guard<std::mutex> lock(vendor);
      insideProducer=true;
      hold(); { RuntimeScope r(7); ProgressGuard p(1); publish(stamp(Host)); }
      release(); insideProducer=false;
    }); thread.join();
    verify(!ready.load() && initialization.load()==0);
    verify(owned()==0 && ingress.write.load()==0);
  } else if (!std::strcmp(mode,"ready")) {
    initialize(); verify(owned()==0); // queue lifecycle is NOT context warming
    std::mutex vendor; Event row;
    std::thread thread([&] {
      {
        std::lock_guard<std::mutex> lock(vendor);
        insideProducer=true; hold(); hold(); roundtrip(); release();
        if (ingress.write.load()!=0) std::abort();
        insideProducer=false;
      }
      insideProducer=true; release(); insideProducer=false;
    }); thread.join();
    verify(owned()==0 && !contextClosed.load());
    std::vector<int> stages;
    while (ingress.poll(row)) {
      verify(row.runtime==7 && row.request[0]=='a');
      stages.push_back(row.stage);
    }
    verify(stages==std::vector<int>({8,11,9,15,16,17}));
    std::thread exceptionThread([] {
      try { RuntimeScope scope(9); throw 123; } catch (int) {}
    }); exceptionThread.join();
    verify(owned()==0);
  } else if (!std::strcmp(mode,"parallel")) {
    initialize(); verify(owned()==0);
    std::atomic<int> entered{0};
    std::atomic<int> wrongScope{0};
    std::vector<std::thread> threads;
    for(int i=0;i<8;++i)threads.emplace_back([&,i] {
      auto e=request(); std::memset(e.request,'0'+i,32);
      insideProducer=true;
      {
        RuntimeScope runtime(7);
        hold(); auto registration=begin(e); insideProducer=false;
        ++entered; while(entered.load()!=8)std::this_thread::yield();
        insideProducer=true;
        if(scope().request[0]!='0'+i || currentRuntime()!=7)++wrongScope;
        selected(7,100+i); admitted(11,100+i,8000); end(registration,100+i);
        timer(Submit,7,11,100+i); timer(RuntimeEnter,7,11,100+i); callback(registration);
        release();
      }
      insideProducer=false;
    });
    for(auto& t:threads)t.join();
    int counts[8][22]{}; Event e;
    while(ingress.poll(e)) {
      const int identity=e.request[0]-'0';
      verify(identity>=0 && identity<8 && e.runtime==7);
      verify(e.stage==8 || e.handle==100+identity);
      ++counts[identity][e.stage];
    }
    // Registration scope must be exact for every thread. The PRE-EXISTING
    // binding table deliberately try-drops on contention; don't mistake its
    // counted read loss for an ownership failure or require blocking reads.
    for(int i=0;i<8;++i) {
      verify(counts[i][8]==1 && counts[i][9]==1);
      for(int stage:{11,15,16,17}) {
        verify(counts[i][stage]<=1);
        if(counts[i][stage]==0)verify(bindingContention.load()>0 || bindingLoss.load()>0);
      }
    }
    verify(wrongScope.load()==0);
    verify(owned()==0 && !contextClosed.load() && contextLoss.load()==0);
  } else if (!std::strcmp(mode,"reuse")) {
    initialize(); verify(owned()==0);
    for (int i=0;i<1000;++i) {
      std::thread t([] { insideProducer=true; roundtrip(); insideProducer=false; });
      t.join(); verify(owned()==0 && !contextClosed.load());
      Event row; int count=0; while (ingress.poll(row)) ++count;
      verify(count==6);
    }
    verify(contextExhaustions.load()==0 && contextLoss.load()==0);
  } else if (!std::strcmp(mode,"exhaustion")) {
    initialize();
    std::atomic<unsigned> entered{0}; std::atomic<bool> leave{false};
    std::vector<std::thread> threads;
    for (size_t i=0;i<localCapacity;++i) threads.emplace_back([&] {
      insideProducer=true; hold(); publish(stamp(Host)); insideProducer=false;
      ++entered;
      while(!leave.load()) std::this_thread::yield(); // blocked TEST consumers only
      insideProducer=true; release(); insideProducer=false;
    });
    while(entered.load()!=localCapacity) std::this_thread::yield();
    verify(owned()==localCapacity && ingress.write.load()==0);
    insideProducer=true; hold(); publish(stamp(Host)); insideProducer=false;
    verify(contextClosed.load() && contextExhaustions.load()==1);
    leave.store(true); for(auto& t:threads)t.join();
    verify(owned()==0 && ingress.write.load()==0);
    // A slot is now free. A failed hold must NOT turn into unheld admission.
    insideProducer=true; publish(stamp(Host)); release(); roundtrip(); insideProducer=false;
    verify(owned()==0 && ingress.write.load()==0 && contextClosed.load());
    verify(contextLoss.load()>=localCapacity);
  } else std::abort();
  verify(forbidden.load()==0);
  std::cout<<"PASS "<<checks<<" cold producer assertions ("<<mode<<"); forbidden calls=0; pool="
    <<sizeof(localStates)+sizeof(localOwners)<<"B; initialized by loader, not producer\n";
}
