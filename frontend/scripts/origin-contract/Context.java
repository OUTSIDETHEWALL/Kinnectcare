package android.content;
import java.io.File;
public class Context {
  public static volatile boolean failFiles = false;
  public static volatile java.util.concurrent.CountDownLatch filesGate, filesEntered;
  private final File root;
  public Context(File root) { this.root = root; }
  public Context getApplicationContext() { return this; }
  public File getFilesDir() {
    if (filesEntered != null) filesEntered.countDown();
    if (filesGate != null) try { filesGate.await(); } catch (InterruptedException e) { throw new IllegalStateException(e); }
    if (failFiles) throw new IllegalStateException("credential storage unavailable");
    if (!Thread.currentThread().getName().contains("kinnship-origins")
        && !Thread.currentThread().getName().contains("kinnship-deep-async")
        && !Thread.currentThread().getName().contains("kinnship-evidence")) throw new AssertionError("disk on producer");
    return root;
  }
}
