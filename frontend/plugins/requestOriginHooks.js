// Source hooks only. No header, extra request, listener, cancellation or timeout policy.
const MARK = 'KinnshipRequestOrigins';
function once(source, needle, replacement) {
  if (source.split(needle).length !== 2) throw new Error(`Origin source drift: ${needle.slice(0, 90)}`);
  return source.replace(needle, replacement);
}
function rnJs(source) {
  if (source.includes(MARK)) return source;
  return once(source, 'const requestId = generateRequestId();', `const requestId = generateRequestId();
    // ${MARK}: purely local metadata, before the existing native dispatch.
    try { global.__kinnshipBindRequestOrigin?.(requestId); } catch (_) {}`);
}
function manager(source) {
  if (source.includes(MARK)) return source;
  let next = once(source, 'addTask(task);', `addTask(task);
        // ${MARK}
        KinnshipOriginBridge.task(context, task.mParams, "queued", task.getReactTaskId(), task.mTimeout);`);
  next = once(next, 'mReactTaskId = headlessJsTaskContext.startTask(buildTaskConfig());',
    `mReactTaskId = headlessJsTaskContext.startTask(buildTaskConfig());
            KinnshipOriginBridge.task(reactContext, mParams, "invoked", mReactTaskId, mTimeout);`);
  next = once(next, 'private void removeTask(Task task) {', `private void removeTask(Task task) {
        KinnshipOriginBridge.task(null, task.mParams, "removed", task.getReactTaskId(), task.mTimeout);`);
  return once(next, 'Task task = findTask(taskId);', `KinnshipOriginBridge.finish(context, taskId);
            Task task = findTask(taskId);
            if (task == null) KinnshipOriginBridge.missing(context, taskId);`);
}
function sdkJs(source) {
  if (source.includes(MARK)) return source;
  let next = once(source, 'const taskId = event._transistorHeadlessTaskId;', `const taskId = event._transistorHeadlessTaskId;
          // ${MARK}: preserve the ID before the vendor deletes it.
          const kcWakeId = event.kcEvidenceWakeId;
          const kcSettled = (reason) => {
            try { global.__kinnshipTaskSettled?.(kcWakeId, taskId, reason); } catch (_) {}
          };`);
  next = once(next, 'taskProvider(event).then(() => {', "taskProvider(event).then(() => {\n            kcSettled('fulfilled');");
  return once(next, '}).catch(reason => {', "}).catch(reason => {\n            kcSettled('rejected');");
}
function bridge(pkg) {
  return `package ${pkg};
// ${MARK}. Cached reflection avoids adding vendor -> Expo compile dependencies.
public final class KinnshipOriginBridge {
  private static volatile java.lang.reflect.Method record;
  private static volatile java.lang.reflect.Method install;
  private static void prepare(android.content.Context context) throws Exception {
    if (record == null) {
      Class<?> recorder = Class.forName("expo.modules.startupdiagnostics.RequestOrigins");
      install = recorder.getMethod("install", android.content.Context.class);
      record = recorder.getMethod("record", String.class, String.class, String.class, String.class);
    }
    if (context != null) install.invoke(null, context);
  }
  private static void emit(android.content.Context context, String id, String stage, org.json.JSONObject detail) {
    try { prepare(context); record.invoke(null, "task", id, stage, detail.toString()); }
    catch (Throwable ignored) {}
  }
  public static void task(android.content.Context context, com.facebook.react.bridge.ReadableMap data, String stage, int reactId, int timeout) {
    try {
      String wake = data.getString("kcEvidenceWakeId");
      if (wake == null || wake.isEmpty()) return;
      emit(context, wake, stage, new org.json.JSONObject().put("wake", wake)
        .put("taskId", data.getInt("_transistorHeadlessTaskId")).put("reactTaskId", reactId)
        .put("trigger", data.getString("name"))
        .put("context", context == null ? org.json.JSONObject.NULL : System.identityHashCode(context)).put("timeoutMs", timeout));
    } catch (Throwable ignored) {}
  }
  public static void finish(android.content.Context context, int taskId) {
    try { emit(context, "sdk-" + taskId, "finish_requested", new org.json.JSONObject().put("taskId", taskId)); }
    catch (Throwable ignored) {}
  }
  public static void missing(android.content.Context context, int taskId) {
    try { emit(context, "sdk-" + taskId, "missing_finish", new org.json.JSONObject().put("taskId", taskId)); }
    catch (Throwable ignored) {}
  }
}
`;
}
module.exports = { rnJs, manager, sdkJs, bridge };
