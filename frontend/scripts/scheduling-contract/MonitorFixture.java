public class MonitorFixture {
  static class Box { final int value; Box(int value) { this.value = value; } }
  @java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME)
  @java.lang.annotation.Target(java.lang.annotation.ElementType.TYPE_USE)
  @interface Marker {}
  public static void main(String[] args) {
    com.facebook.react.jstasks.HeadlessJsTaskContext task = new com.facebook.react.jstasks.HeadlessJsTaskContext();
    if (task.startTask(false) != 7) throw new AssertionError("return changed");
    try { task.startTask(true); throw new AssertionError("exception swallowed"); }
    catch (@Marker IllegalArgumentException expected) { }
    if (new Box(task.startTask(false)).value != 7) throw new AssertionError("constructor prefix changed");
    if (100L + task.startTask(false) != 107L) throw new AssertionError("wide prefix changed");
    try { new Box(task.startTask(true)); throw new AssertionError("prefixed exception swallowed"); }
    catch (IllegalArgumentException expected) { }
    com.facebook.react.runtime.SchedulingProbe.failRelease = true;
    if (new Box(task.startTask(false)).value != 7) throw new AssertionError("observer failure lost prefix");
    com.facebook.react.runtime.SchedulingProbe.failRelease = false;
    if (com.facebook.react.runtime.SchedulingProbe.depth != 0) throw new AssertionError("scope leaked");
    if (com.facebook.react.runtime.SchedulingProbe.safe != 6) throw new AssertionError("unsafe admission");
    System.out.println("PASS 8 JVM monitor assertions: return/exception/scope/admission, constructor/wide prefixes, prefixed exception and observer failure");
  }
}
