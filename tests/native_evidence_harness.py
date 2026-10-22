"""Execute actual debug-compiled observer classes with small Android JVM test doubles.

Not an emulator/phone test: AtomicFile fsync, Android scheduling and shrinker delivery
remain unverified. Dependencies come from the native validation's resolved cache.
"""
import argparse
import pathlib
import subprocess
import tempfile

STUBS = {
    "android/content/Context.java": """
package android.content;
public class Context {
  private final java.io.File root;
  public Context(java.io.File root) { this.root = root; }
  public Context getApplicationContext() { return this; }
  public java.io.File getFilesDir() { android.util.AtomicFile.checkThread(); return root; }
}""",
    "android/os/Process.java": """
package android.os;
public class Process { public static final int THREAD_PRIORITY_BACKGROUND = 10; }""",
    "android/os/SystemClock.java": """
package android.os;
public class SystemClock { public static long elapsedRealtime() { return System.nanoTime()/1000000; } }""",
    "android/os/Looper.java": """
package android.os;
public class Looper {
  public final java.util.concurrent.ScheduledExecutorService executor =
    java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r -> {
      Thread t = new Thread(r, "kinnship-evidence"); t.setDaemon(true); return t;
    });
}""",
    "android/os/HandlerThread.java": """
package android.os;
public class HandlerThread extends Thread {
  private final Looper looper = new Looper();
  public HandlerThread(String name, int priority) { super(name); }
  public Looper getLooper() { return looper; }
}""",
    "android/os/Handler.java": """
package android.os;
public class Handler {
  private final Looper looper;
  public Handler(Looper looper) { this.looper = looper; }
  public boolean post(Runnable run) { looper.executor.execute(run); return true; }
  public boolean postDelayed(Runnable run, long delay) {
    looper.executor.schedule(run, delay, java.util.concurrent.TimeUnit.MILLISECONDS); return true;
  }
}""",
    "android/util/AtomicFile.java": """
package android.util;
public class AtomicFile {
  public static volatile boolean wrongThread = false;
  public static volatile long bytesWritten = 0;
  public static volatile boolean failWrites = false;
  public static void checkThread() {
    if (!Thread.currentThread().getName().equals("kinnship-evidence")) wrongThread = true;
  }
  private final java.io.File file;
  public AtomicFile(java.io.File file) { this.file = file; }
  public byte[] readFully() throws java.io.IOException {
    checkThread(); return java.nio.file.Files.readAllBytes(file.toPath());
  }
  public java.io.FileOutputStream startWrite() throws java.io.IOException {
    checkThread();
    if (failWrites) throw new java.io.IOException("injected observer disk failure");
    return new java.io.FileOutputStream(new java.io.File(file + ".new"));
  }
  public void finishWrite(java.io.FileOutputStream out) {
    checkThread();
    try {
      out.close(); java.io.File pending = new java.io.File(file + ".new");
      bytesWritten += pending.length();
      java.nio.file.Files.move(pending.toPath(), file.toPath(),
        java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    } catch (java.io.IOException failure) { throw new RuntimeException(failure); }
  }
  public void failWrite(java.io.FileOutputStream out) {
    try { out.close(); } catch (Exception ignored) {}
    new java.io.File(file + ".new").delete();
  }
  public void delete() {
    checkThread(); file.delete(); new java.io.File(file + ".new").delete();
    new java.io.File(file + ".bak").delete();
  }
}""",
    "com/facebook/react/modules/network/CustomClientBuilder.java": """
package com.facebook.react.modules.network;
public interface CustomClientBuilder { void apply(okhttp3.OkHttpClient.Builder builder); }""",
    "com/facebook/react/modules/network/NetworkingModule.java": """
package com.facebook.react.modules.network;
public class NetworkingModule {
  private static CustomClientBuilder customClientBuilder;
  public static final Companion Companion = new Companion();
  public static class Companion {
    public void setCustomClientBuilder(CustomClientBuilder builder) { customClientBuilder = builder; }
  }
  public static void setCustomClientBuilder(CustomClientBuilder builder) { customClientBuilder = builder; }
  public static CustomClientBuilder current() { return customClientBuilder; }
}""",
}

HARNESS = r"""
import expo.modules.startupdiagnostics.*;
import android.content.Context;
import android.util.AtomicFile;
import com.facebook.react.modules.network.*;
import java.io.*;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.*;
import okhttp3.*;
import okhttp3.EventListener;
import org.json.*;

public class EvidenceHarness {
  static void check(boolean good, String message) {
    if (!good) throw new AssertionError(message);
  }
  static Context context;
  static File dataRoot;
  static JSONObject snapshot() { return new JSONObject(EvidenceTrace.read(context)); }
  static JSONObject drained() throws Exception {
    for (int i=0; i<200; i++) {
      JSONObject result = snapshot();
      if (result.optBoolean("available") && result.optInt("pendingEvents") == 0) return result;
      Thread.sleep(10);
    }
    throw new AssertionError("observer failed to drain");
  }
  static void event(String channel, String stage, String id, String detail, long wall, long elapsed) throws Exception {
    Class<?> packet = Class.forName("expo.modules.startupdiagnostics.EvidenceTrace$Pending");
    Constructor<?> constructor = packet.getDeclaredConstructors()[0]; constructor.setAccessible(true);
    Field field = EvidenceTrace.class.getDeclaredField("pending"); field.setAccessible(true);
    BlockingQueue<Object> queue = (BlockingQueue<Object>)field.get(null);
    Object value = constructor.newInstance(channel, stage, id, detail, wall, elapsed);
    check(queue.offer(value), "controlled replay unexpectedly overfilled");
    Method drain = EvidenceTrace.class.getDeclaredMethod("scheduleDrain"); drain.setAccessible(true); drain.invoke(EvidenceTrace.INSTANCE);
  }
  static void bounds(JSONObject result) {
    check(result.getJSONArray("http").length() <= 512, "HTTP cap");
    check(result.getJSONArray("gps").length() <= 2048, "GPS cap");
    JSONObject hours = result.getJSONObject("hourlyCounts");
    check(hours.length() <= 48, "hour cap");
    for (String key: hours.keySet()) check(hours.getJSONObject(key).length() <= 257, "counter key cap");
    check(!result.toString().contains("PRIVATE_TEST_VALUE"), "privacy filtering");
  }
  static void replay() throws Exception {
    EvidenceTrace.install(context); drained();
    long base = System.currentTimeMillis()/3600000*3600000 - 199L*3600000;
    String[] stages = {"native_wake_received","native_task_queued","native_task_invoke",
      "js_wake_received","claim_decision","native_gps_requested","gps_callback_received","publication_result"};
    for (int hour=0; hour<200; hour++) {
      for (int quarter=0; quarter<4; quarter++) {
        String id = String.format("%032x", hour*4+quarter+1);
        for (int step=0; step<(hour>=192 ? 2 : stages.length); step++)
          event("gps", stages[step], id,
            "{\"source\":\"heartbeat\",\"reason\":\"allowed\",\"owner\":\"PRIVATE_TEST_VALUE\"}",
            base+hour*3600000L+quarter*900000L, hour*3600000L+quarter*900000L);
      }
      if (hour%4 == 3) drained();
    }
    JSONObject before = drained(); bounds(before);
    check(before.getJSONArray("gps").length() == 2048, "GPS ring never reached its cap");
    JSONObject hours = before.getJSONObject("hourlyCounts");
    check(hours.length()==48, "48 retained hours");
    for(int hour=192; hour<200; hour++) {
      JSONObject count = hours.getJSONObject(Long.toString((base+hour*3600000L)/3600000));
      check(count.getLong("native_wake_received:heartbeat:allowed")==4, "overnight wake count");
      check(count.getLong("native_task_queued:heartbeat:allowed")==4, "overnight queue count");
      check(!count.has("native_gps_requested:heartbeat:allowed"), "invented overnight acquisition");
    }
    // Flood the independent HTTP ring, then verify no overnight GPS count changed.
    Field writer = EvidenceTrace.class.getDeclaredField("writer$delegate"); writer.setAccessible(true);
    android.os.Handler handler = (android.os.Handler)((kotlin.Lazy<?>)writer.get(null)).getValue();
    CountDownLatch started = new CountDownLatch(1), release = new CountDownLatch(1);
    handler.post(() -> { started.countDown(); try { release.await(20,TimeUnit.SECONDS); } catch(Exception ignored){} });
    check(started.await(2,TimeUnit.SECONDS),"worker block fixture");
    for(int i=0;i<20000;i++)
      EvidenceTrace.record(context, "http", "native_call_start", String.format("%032x",i),
        "{\"queued\":1,\"token\":\"PRIVATE_TEST_VALUE\"}");
    check(!snapshot().optBoolean("available"),"blocked export must report unavailable, not false absence");
    release.countDown();
    JSONObject after = drained(); bounds(after);
    check(after.getLong("queueDropped")>=18976,"bounded queue overflow not reported");
    check(after.getJSONObject("hourlyCounts").toString().equals(hours.toString()), "HTTP erased GPS counts");
    // More valid stage/source/reason combinations than one hourly bucket admits.
    Field reasons = EvidenceTrace.class.getDeclaredField("reasons"); reasons.setAccessible(true);
    int generated=0;
    for(String source: new String[]{"heartbeat","boot","terminate","workmanager"})
      for(String stage: stages)
        for(Object reason: (Set<?>)reasons.get(null)) {
          event("gps", stage, "", new JSONObject().put("source",source).put("reason",reason).toString(),
            base+152L*3600000, 200L*3600000);
          if(++generated%128==0) drained();
        }
    after = drained(); bounds(after);
    check(after.getJSONObject("hourlyCounts").getJSONObject(Long.toString((base+152L*3600000)/3600000))
      .optLong("counter_overflow")>0, "counter overflow not reported");
    Thread.sleep(1300); after=drained();
    AtomicFile.failWrites=true;
    EvidenceTrace.record(context,"http","js_adapter_started","b".repeat(32),"{}");
    drained(); Thread.sleep(1300);
    check(drained().getLong("writeFailures")>0, "disk failure not surfaced");
    AtomicFile.failWrites=false;
    EvidenceTrace.record(context,"http","js_adapter_settled","b".repeat(32),"{}");
    drained(); Thread.sleep(1300); after=drained();
    check(!AtomicFile.wrongThread, "disk/initialization touched producer thread");
    File dir = new File(dataRoot,"kinnship_bounded_evidence_v2");
    check(dir.list().length<=129, "file count not bounded");
    long size=0; for(File file: dir.listFiles()) { check(file.length()<=131072, "page cap"); size+=file.length(); }
    check(size<3_000_000, "unexpected retention size");
    System.out.println("REPLAY_PASS " + new JSONObject().put("files",dir.list().length).put("bytes",size)
      .put("queueDropped",after.getLong("queueDropped")).put("writeBytes",AtomicFile.bytesWritten));
  }
  static void reload() throws Exception {
    JSONObject result=drained(); bounds(result);
    check(result.getJSONArray("gps").length()==2048, "restart lost GPS history");
    check(result.getJSONObject("hourlyCounts").length()==48, "restart lost hourly history");
    check(result.optLong("readFailures")>0, "corrupt page not reported");
    check(!AtomicFile.wrongThread, "restart IO touched producer thread");
    System.out.println("RELOAD_PASS");
  }
  static void clock() throws Exception {
    EvidenceTrace.install(context); drained();
    for(int hour=-80;hour<0;hour++) {
      event("gps","native_wake_received",String.format("%032x",hour+81),
        "{\"source\":\"heartbeat\"}",hour*3600000L,(hour+81)*3600000L);
      if(hour%8==0)drained();
    }
    JSONObject result=drained(); bounds(result);
    check(result.getJSONObject("hourlyCounts").length()==48,"negative clock hour cap");
    check(result.getJSONObject("hourlyCounts").has("-1"),"negative hour lost");
    check(result.getLong("readFailures")>0,"unfinished atomic pages not reported");
    Thread.sleep(1300); drained();
    File[] files=new File(dataRoot,"kinnship_bounded_evidence_v2").listFiles();
    check(files.length<=129,"clock/unfinished pages accumulated");
    System.out.println("CLOCK_AND_ORPHAN_PASS files="+files.length);
  }
  static final Set<String> forwarded = new HashSet<>();
  static void transport(boolean occupied) throws Exception {
    CustomClientBuilder prior = b -> {};
    if(occupied) NetworkingModule.setCustomClientBuilder(prior);
    NativeHttpEvidence.install(context);
    if(occupied) {
      check(NetworkingModule.current()==prior, "overwrote existing global hook");
      check(drained().getString("httpObserverStatus").equals("declined_existing_custom_builder"), "missing declined status");
      System.out.println("OCCUPIED_HOOK_PASS"); return;
    }
    EventListener original = new EventListener() {
      public void proxySelectStart(Call c,HttpUrl u) {forwarded.add("proxySelectStart");}
      public void proxySelectEnd(Call c,HttpUrl u,List<java.net.Proxy> p) {forwarded.add("proxySelectEnd");}
      public void satisfactionFailure(Call c,Response r) {forwarded.add("satisfactionFailure");}
      public void cacheHit(Call c,Response r) {forwarded.add("cacheHit");}
      public void cacheMiss(Call c) {forwarded.add("cacheMiss");}
      public void cacheConditionalHit(Call c,Response r) {forwarded.add("cacheConditionalHit");}
    };
    OkHttpClient base = new OkHttpClient.Builder().eventListener(original).build();
    OkHttpClient.Builder builder=base.newBuilder();
    NetworkingModule.current().apply(builder);
    OkHttpClient observed=builder.build();
    for(String key:new String[]{"dispatcher","connectionPool","dns","cache","proxy","proxySelector",
      "socketFactory","sslSocketFactory","hostnameVerifier","certificatePinner","cookieJar","protocols",
      "connectionSpecs","connectTimeoutMillis","readTimeoutMillis","writeTimeoutMillis","callTimeoutMillis",
      "pingIntervalMillis","retryOnConnectionFailure","followRedirects","followSslRedirects"}) {
      Method method=OkHttpClient.class.getMethod(key);
      check(Objects.equals(method.invoke(base),method.invoke(observed)), "changed client policy/resource: "+key);
    }
    Request request=new Request.Builder().url("https://example.invalid/api/members")
      .header("X-Kinnship-Startup-Trace", "a".repeat(32)).build();
    Call call=observed.newCall(request);
    EventListener wrapper=observed.eventListenerFactory().create(call);
    int overrides=0;
    for(Method method:EventListener.class.getDeclaredMethods()) {
      if(Modifier.isStatic(method.getModifiers()) || !Modifier.isPublic(method.getModifiers())) continue;
      check(wrapper.getClass().getMethod(method.getName(),method.getParameterTypes()).getDeclaringClass()!=EventListener.class,
        "missing listener callback: "+method.getName()); overrides++;
    }
    Response response=new Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK").build();
    wrapper.proxySelectStart(call,request.url()); wrapper.proxySelectEnd(call,request.url(),List.of(java.net.Proxy.NO_PROXY));
    wrapper.satisfactionFailure(call,response); wrapper.cacheHit(call,response); wrapper.cacheMiss(call);
    wrapper.cacheConditionalHit(call,response); check(forwarded.size()==6,"lost existing listener callback");
    Interceptor.Chain chain=(Interceptor.Chain)Proxy.newProxyInstance(EvidenceHarness.class.getClassLoader(),
      new Class[]{Interceptor.Chain.class},(p,m,a)-> {
        if(m.getName().equals("call"))return call;
        if(m.getName().equals("request"))return request;
        if(m.getName().equals("proceed")) {check(a[0]==request,"rewrote request"); return response;}
        throw new UnsupportedOperationException(m.getName());
      });
    check(observed.interceptors().get(observed.interceptors().size()-1).intercept(chain)==response,"rewrote response");
    Request unmarked=new Request.Builder().url("https://example.invalid/api/members").build();
    check(observed.eventListenerFactory().create(observed.newCall(unmarked))==original, "wrapped unmarked call");
    CustomClientBuilder hook=NetworkingModule.current(); NativeHttpEvidence.install(context);
    check(NetworkingModule.current()==hook,"installed twice");
    check(drained().getString("httpObserverStatus").equals("installed"),"hook not registered");
    System.out.println("TRANSPORT_PASS callbacks="+overrides);
  }
  public static void main(String[] args) throws Exception {
    dataRoot=new File(args[1]); context=new Context(dataRoot);
    switch(args[0]) {
      case "replay": replay(); break;
      case "reload": reload(); break;
      case "transport": transport(false); break;
      case "occupied": transport(true); break;
      case "clock": clock(); break;
      default: throw new AssertionError(args[0]);
    }
  }
}
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--validation", type=pathlib.Path, required=True)
    args = parser.parse_args()
    validation = args.validation.resolve()
    cache = validation / "gradle/caches/modules-2/files-2.1"
    project = validation / "evidence-candidate/frontend"
    native = project / "modules/startup-diagnostics/android/build/tmp/kotlin-classes/debug"
    assert (native / "expo/modules/startupdiagnostics/EvidenceTrace.class").is_file()

    def jar(group, artifact, version):
        matches = list((cache / group / artifact / version).glob("*/*.jar"))
        assert len(matches) == 1, (group, artifact, version, matches)
        return matches[0]

    dependencies = [
        jar("com.squareup.okhttp3", "okhttp", "4.12.0"),
        jar("com.squareup.okio", "okio-jvm", "3.6.0"),
        jar("org.jetbrains.kotlin", "kotlin-stdlib", "2.1.20"),
        jar("org.json", "json", "20180813"),
    ]
    with tempfile.TemporaryDirectory(prefix="observer-harness-", dir=validation) as temporary:
        root = pathlib.Path(temporary)
        for name, source in {**STUBS, "EvidenceHarness.java": HARNESS}.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(source)
        classes = root / "classes"
        classes.mkdir()
        classpath = ":".join(map(str, [classes, native, *dependencies]))
        subprocess.run(["javac", "-cp", classpath, "-d", str(classes),
                        *map(str, root.rglob("*.java"))], check=True)
        for mode in ("transport", "occupied", "replay", "reload", "clock"):
            data = root / ("retention" if mode in ("replay", "reload") else mode)
            data.mkdir(exist_ok=True)
            if mode == "reload":
                # The rest of the store must remain usable after an overlarge page.
                (data / "kinnship_bounded_evidence_v2/http_0.json").write_text("x" * 131073)
            if mode == "clock":
                directory = data / "kinnship_bounded_evidence_v2"
                directory.mkdir()
                for hour in range(-200, -120):
                    (directory / f"hour_{hour}.json.new").write_text("{}")
            subprocess.run(["java", "-XX:-UsePerfData", "-cp", classpath, "EvidenceHarness", mode, str(data)],
                           check=True, timeout=120)


if __name__ == "__main__":
    main()
