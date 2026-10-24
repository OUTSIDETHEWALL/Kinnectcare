package android.content;
import java.io.File;
public class Context {
  public static volatile boolean failFiles = false;
  private final File root;
  public Context(File root) { this.root = root; }
  public Context getApplicationContext() { return this; }
  public File getFilesDir() {
    if (failFiles) throw new IllegalStateException("credential storage unavailable");
    if (!Thread.currentThread().getName().contains("kinnship-origins")
        && !Thread.currentThread().getName().contains("kinnship-deep-async")) throw new AssertionError("disk on producer");
    return root;
  }
}
