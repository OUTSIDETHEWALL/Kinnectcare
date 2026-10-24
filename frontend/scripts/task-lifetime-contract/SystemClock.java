package android.os;
/** Deterministic JVM substitute; never packaged into the app. */
public final class SystemClock {
  public static volatile long now = 1000;
  public static long elapsedRealtime() { return now; }
}
