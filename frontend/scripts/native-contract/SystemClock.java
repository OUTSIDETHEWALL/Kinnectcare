package android.os;

/** JVM test substitute for a monotonic Android clock. */
public final class SystemClock {
  public static long elapsedRealtime() { return System.nanoTime() / 1000000L; }
}
