package com.facebook.react.runtime;
public class SchedulingProbe {
  public static int depth, pending, safe;
  public static boolean failRelease;
  public static void hold() { depth++; }
  public static void release() {
    if (--depth == 0) { safe += pending; pending = 0; }
    if (failRelease) throw new LinkageError("observer failure");
  }
}
