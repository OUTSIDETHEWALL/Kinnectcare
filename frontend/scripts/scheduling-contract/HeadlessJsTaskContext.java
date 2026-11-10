package com.facebook.react.jstasks;
public class HeadlessJsTaskContext {
  public synchronized int startTask(boolean fail) {
    if (com.facebook.react.runtime.SchedulingProbe.depth <= 0) throw new AssertionError("missing outer scope");
    com.facebook.react.runtime.SchedulingProbe.pending++;
    if (fail) throw new IllegalArgumentException("original");
    return 7;
  }
}
