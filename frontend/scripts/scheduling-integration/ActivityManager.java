package android.app;
public class ActivityManager {
  public static class RunningAppProcessInfo { public int importance; }
  public static void getMyMemoryState(RunningAppProcessInfo info) { info.importance = 100; }
}
