#include "../../modules/startup-diagnostics/native/SchedulingCore.h"
#include <cassert>
#include <chrono>
#include <iostream>
#include <thread>
#include <vector>
using namespace kinnship78;
static int tests = 0;
static void check(bool condition) { assert(condition); ++tests; }
int main() {
  Event e = stamp(ScheduleEnter);
  std::strcpy(e.request, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  std::strcpy(e.operation, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  std::strcpy(e.flight, "cccccccccccccccccccccccccccccccc");
  check(begin(e) == 0); // cold producer never initializes its consumer
  initialize();
  auto reg = begin(e); check(reg > 0);
  selected(7, 12); admitted(22, 12, 8000); end(reg, 12);
  timer(Submit, 7, 0, 12); timer(RuntimeEnter, 7, 0, 12, 0, 1); callback(reg);
  std::vector<int> stages; Event row;
  while (ingress.poll(row)) {
    check(std::strcmp(row.request, e.request) == 0);
    check(row.elapsed > 0 && row.uptime > 0);
    stages.push_back(row.stage);
  }
  check(stages == std::vector<int>({ScheduleEnter, Admitted, ScheduleReturn, Submit, RuntimeEnter, Callback}));
  check(find(7, 22, 12).registration == 0);
  auto nested = begin(e); auto nested2 = begin(e); end(nested2, 1); end(nested, 2);
  while (ingress.poll(row)) {}
  hold(); hold();
  auto sequenceBefore = sequences.load();
  auto held = stamp(Host); publish(held);
  check(sequences.load() == sequenceBefore);
  check(!ingress.poll(row)); release(); check(!ingress.poll(row));
  release(); check(ingress.poll(row) && row.stage == Host);
  auto a = begin(e), b = begin(e), c = begin(e), d = begin(e);
  auto overflow = begin(e); check(overflow == uint64_t(-1));
  end(overflow, -1); end(d, 1); end(c, 2); end(b, 3); end(a, 4);
  { LocalLease lease; check(lease && lease.state->depth == 0 && lease.state->overflow == 0); }
  while (ingress.poll(row)) {}
  // Full ingress cannot backpressure application producers.
  for (int i = 0; i < 4096; ++i) publish(held);
  check(ingress.drops.load() >= 2048);
  while (ingress.poll(row)) {}
  auto start = std::chrono::steady_clock::now();
  std::vector<std::thread> producers;
  for (int n = 0; n < 4; ++n) producers.emplace_back([&] {
    for (int i = 0; i < 10000; ++i) publish(stamp(Host));
  });
  for (auto& p : producers) p.join();
  auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
  check(ms < 5000);
  ProgressGuard guard(1);
  std::cout << "PASS " << tests << " C++ core assertions; concurrent admission 40000 events "
            << ms << "ms; Event=" << sizeof(Event) << "B; ring=" << sizeof(ingress) << "B\n";
  std::cout << "LIMIT: host C++ contract, not Android scheduling/RN library/phone acceptance\n";
}
