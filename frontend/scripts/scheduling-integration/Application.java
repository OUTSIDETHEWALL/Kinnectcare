package android.app;
import android.content.Context;
import android.os.Bundle;
import java.io.File;
/** JVM lifecycle adapter, not shipped Android code. */
public class Application extends Context {
  public Application(File root) { super(root); }
  public ActivityLifecycleCallbacks callbacks;
  public void registerActivityLifecycleCallbacks(ActivityLifecycleCallbacks value) { callbacks = value; }
  public interface ActivityLifecycleCallbacks {
    void onActivityCreated(Activity a, Bundle b);
    void onActivityStarted(Activity a);
    void onActivityResumed(Activity a);
    void onActivityPaused(Activity a);
    void onActivityStopped(Activity a);
    void onActivityDestroyed(Activity a);
    void onActivitySaveInstanceState(Activity a, Bundle b);
  }
}
