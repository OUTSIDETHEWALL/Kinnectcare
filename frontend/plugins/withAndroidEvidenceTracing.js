// Source-only observational hooks. Never run prebuild/build as part of installation.
const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');
const MARKER = 'KinnshipBoundedEvidence';
function once(source, needle, replacement) {
  if (source.split(needle).length !== 2) throw new Error(`Evidence hook source drift: ${needle.slice(0, 70)}`);
  return source.replace(needle, replacement);
}
function bridge(packageName) {
  return `package ${packageName};
// ${MARKER}: reflection avoids a dependency from the vendor library to the app module.
final class KinnshipEvidenceBridge {
  private static android.content.Context application;
  static String newId() { return java.util.UUID.randomUUID().toString().replace("-", ""); }
  static void record(android.content.Context context, String stage, String id, String source) {
    try {
      if (context != null) application = context.getApplicationContext();
      if (application == null) return;
      Class<?> recorder = Class.forName("expo.modules.startupdiagnostics.EvidenceTrace");
      recorder.getMethod("record", android.content.Context.class, String.class, String.class, String.class, String.class)
        .invoke(null, application, "gps", stage, id == null ? "" : id,
          new org.json.JSONObject().put("source", source).toString());
    } catch (Throwable ignored) { /* observation cannot interrupt native work */ }
  }
  static String positionId(com.facebook.react.bridge.ReadableMap options) {
    try { return options.getMap("extras").getString("kc_evidence_id"); }
    catch (Throwable ignored) { return ""; }
  }
  static void recordMap(android.content.Context context, String stage,
      com.facebook.react.bridge.ReadableMap data, String source) {
    String id = "";
    try { id = data.getString("kcEvidenceWakeId"); } catch (Throwable ignored) {}
    if (id == null || id.isEmpty()) return;
    if ("other".equals(source)) {
      try { source = data.getString("name"); } catch (Throwable ignored) {}
    }
    record(context, stage, id, source);
  }
}
`;
}
function headless(source) {
  if (source.includes(MARKER)) return source;
  let next = once(source, 'String name = event.getName();', `String name = event.getName();
        // ${MARKER}
        final boolean kcEvidenceWake = java.util.Arrays.asList("heartbeat", "boot", "terminate", "motionchange", "activitychange").contains(name);
        final String kcEvidenceWakeId = kcEvidenceWake ? KinnshipEvidenceBridge.newId() : "";
        if (kcEvidenceWake) KinnshipEvidenceBridge.record(event.getContext(), "native_wake_received", kcEvidenceWakeId, name);`);
  next = once(next, 'clientEvent.putString("name", name);', `clientEvent.putString("name", name);
        if (kcEvidenceWake) clientEvent.putString("kcEvidenceWakeId", kcEvidenceWakeId);`);
  next = once(next, '.setOnFinishCallback(taskId -> {', `.setOnFinishCallback(taskId -> {
                        if (kcEvidenceWake) KinnshipEvidenceBridge.record(event.getContext(), "native_task_finished", kcEvidenceWakeId, name);`);
  return once(next, '.setOnErrorCallback((task, e) -> {', `.setOnErrorCallback((task, e) -> {
                        if (kcEvidenceWake) KinnshipEvidenceBridge.record(event.getContext(), "native_task_error", kcEvidenceWakeId, name);`);
}
function manager(source) {
  if (source.includes(MARKER)) return source;
  let next = once(source, 'addTask(task);', `addTask(task);
        // ${MARKER}
        KinnshipEvidenceBridge.recordMap(context, "native_task_queued", task.mParams, "other");`);
  next = once(next, 'private void createReactContextAndScheduleTask(Context context) {',
    `private void createReactContextAndScheduleTask(Context context) {
        KinnshipEvidenceBridge.record(context, "native_context_requested", "", "other");`);
  next = next.replaceAll('mIsReactContextInitialized.set(true);', `mIsReactContextInitialized.set(true);
                        KinnshipEvidenceBridge.record(context, "native_context_ready", "", "other");`);
  return once(next, 'mReactTaskId = headlessJsTaskContext.startTask(buildTaskConfig());',
    `KinnshipEvidenceBridge.recordMap(reactContext, "native_task_invoke", mParams, "other");
            mReactTaskId = headlessJsTaskContext.startTask(buildTaskConfig());`);
}
function locationModule(source) {
  if (source.includes(MARKER)) return source;
  const signature = 'public void getCurrentPosition(ReadableMap options, final Promise response) {';
  let next = once(source, signature, `${signature}
        // ${MARKER}
        final String kcEvidenceId = KinnshipEvidenceBridge.positionId(options);
        KinnshipEvidenceBridge.record(getReactApplicationContext(), "native_gps_requested", kcEvidenceId, "other");`);
  const begin = next.indexOf(signature);
  const end = next.indexOf('@ReactMethod', begin);
  let method = next.slice(begin, end);
  method = once(method, 'response.resolve(mapToWritableMap(event.toMap()));',
    `KinnshipEvidenceBridge.record(getReactApplicationContext(), "gps_callback_received", kcEvidenceId, "other");
                response.resolve(mapToWritableMap(event.toMap()));`);
  method = once(method, 'response.reject(errorCode.toString());',
    `KinnshipEvidenceBridge.record(getReactApplicationContext(), "gps_callback_failed", kcEvidenceId, "other");
                response.reject(errorCode.toString());`);
  next = next.slice(0, begin) + method + next.slice(end);
  // Existing native heartbeat callback, before dispatch to JS. No listener added.
  return once(next, '@Override public void onHeartbeat(HeartbeatEvent event) {',
    `@Override public void onHeartbeat(HeartbeatEvent event) {
            KinnshipEvidenceBridge.record(getReactApplicationContext(), "native_wake_received", "", "heartbeat");`);
}
function fetchHeadless(source) {
  if (source.includes(MARKER)) return source;
  let next = once(source, 'clientEvent.putString("taskId", task.getTaskId());',
    `// ${MARKER}
        String kcEvidenceWakeId = KinnshipEvidenceBridge.newId();
        KinnshipEvidenceBridge.record(context, "native_wake_received", kcEvidenceWakeId, "workmanager");
        clientEvent.putString("kcEvidenceWakeId", kcEvidenceWakeId);
        clientEvent.putString("taskId", task.getTaskId());`);
  next = once(next, 'UiThreadUtil.assertOnUiThread();', `UiThreadUtil.assertOnUiThread();
        KinnshipEvidenceBridge.recordMap(context, "native_task_queued", taskConfig.getData(), "workmanager");`);
  next = once(next, 'if (reactContext == null) {', `if (reactContext == null) {
            KinnshipEvidenceBridge.recordMap(context, "native_context_requested", taskConfig.getData(), "workmanager");`);
  next = once(next, 'if (reactContext.getLifecycleState() == LifecycleState.RESUMED) {',
    `if (reactContext.getLifecycleState() == LifecycleState.RESUMED) {
            KinnshipEvidenceBridge.recordMap(reactContext, "native_task_skipped", taskConfig.getData(), "workmanager");`);
  next = once(next, 'mBGTask.setCompletionHandler(() -> {', `mBGTask.setCompletionHandler(() -> {
                    KinnshipEvidenceBridge.recordMap(reactContext, "native_task_finished", taskConfig.getData(), "workmanager");`);
  next = once(next, '} catch (IllegalStateException exception) {', `} catch (IllegalStateException exception) {
                KinnshipEvidenceBridge.recordMap(reactContext, "native_task_error", taskConfig.getData(), "workmanager");`);
  return once(next, 'final int taskId = headlessJsTaskContext.startTask(taskConfig);',
    `KinnshipEvidenceBridge.recordMap(reactContext, "native_task_invoke", taskConfig.getData(), "workmanager");
                final int taskId = headlessJsTaskContext.startTask(taskConfig);`);
}
module.exports = function withAndroidEvidenceTracing(config) {
  return withDangerousMod(config, ['android', async cfg => {
    const root = cfg.modRequest.projectRoot;
    const groups = [
      ['react-native-background-geolocation', 'com/transistorsoft/rnbackgroundgeolocation', [
        ['HeadlessTask.java', headless], ['HeadlessTaskManager.java', manager],
        ['RNBackgroundGeolocationModule.java', locationModule],
      ]],
      ['react-native-background-fetch', 'com/transistorsoft/rnbackgroundfetch', [['HeadlessTask.java', fetchHeadless]]],
    ];
    // Validate all transformations before writing any vendor source.
    const changes = [];
    for (const [pkg, directory, files] of groups) {
      const base = path.join(root, 'node_modules', pkg, 'android/src/main/java', directory);
      for (const [file, transform] of files) {
        const target = path.join(base, file);
        changes.push([target, transform(fs.readFileSync(target, 'utf8'))]);
      }
      changes.push([path.join(base, 'KinnshipEvidenceBridge.java'), bridge(directory.replaceAll('/', '.'))]);
    }
    for (const [target, contents] of changes) fs.writeFileSync(target, contents);
    return cfg;
  }]);
};
Object.assign(module.exports, { headless, manager, locationModule, fetchHeadless, bridge });
