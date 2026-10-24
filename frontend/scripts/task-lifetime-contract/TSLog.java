package com.transistorsoft.locationmanager.logger;
/** Logger-only compile substitute, not a location SDK/runtime acceptance test. */
public final class TSLog {
  public static void d(String message) {}
  public static void w(String message) {}
  public static void e(String message) {}
  public static void e(String message, Exception error) {}
  public static String warn(String message) { return message; }
  public static String error(String message) { return message; }
}
