// Operational lifetime fencing, deliberately separate from observational hooks.
const MARK = 'KinnshipHeadlessTaskLifetime';
function once(source, needle, replacement) {
  if (source.split(needle).length !== 2) throw new Error(`Task lifetime source drift: ${needle}`);
  return source.replace(needle, replacement);
}
function manager(source) {
  if (source.includes(MARK)) return source;
  let next = once(source, 'private final int mTimeout;', `private final int mTimeout;
        // ${MARK}: opaque execution identity, never the reusable SDK/RN number.
        private String mKinnshipLifetime = "";
        private volatile int mKinnshipReactTaskId;`);
  next = once(next, 'mReactTaskId = headlessJsTaskContext.startTask(buildTaskConfig());',
    `mKinnshipLifetime = KinnshipTaskLifetimeBridge.begin(mTimeout,
              () -> mKinnshipReactTaskId <= 0 || headlessJsTaskContext.isTaskRunning(mKinnshipReactTaskId));
            mParams.putString("kcTaskLifetime", mKinnshipLifetime);
            mReactTaskId = headlessJsTaskContext.startTask(buildTaskConfig());
            mKinnshipReactTaskId = mReactTaskId;`);
  next = once(next, 'Task task = findTask(taskId);', `Task task = findTask(taskId);
            if (task != null) KinnshipTaskLifetimeBridge.end(task.mKinnshipLifetime);`);
  return once(next, 'private void removeTask(Task task) {', `private void removeTask(Task task) {
        KinnshipTaskLifetimeBridge.end(task.mKinnshipLifetime);`);
}
function bridge(pkg) {
  return `package ${pkg};
// ${MARK}: no observer, disk IO, timer, or tracking-authority mutation.
public final class KinnshipTaskLifetimeBridge {
  private static volatile java.lang.reflect.Method begin;
  private static volatile java.lang.reflect.Method end;
  private static void prepare() throws Exception {
    if (begin == null) {
      Class<?> registry = Class.forName("expo.modules.startupdiagnostics.HeadlessTaskLifetimes");
      end = registry.getMethod("end", String.class);
      begin = registry.getMethod("begin", int.class, java.util.function.BooleanSupplier.class);
    }
  }
  public static String begin(int timeout, java.util.function.BooleanSupplier running) {
    try { prepare(); return (String) begin.invoke(null, timeout, running); }
    catch (Throwable unavailable) { return ""; } // JS fails closed, never fabricates liveness.
  }
  public static void end(String token) {
    try { prepare(); end.invoke(null, token); } catch (Throwable unavailable) {}
  }
}
`;
}
module.exports = { manager, bridge };
