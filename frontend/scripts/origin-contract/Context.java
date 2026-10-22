package android.content;
import java.io.File;
public class Context {
  private final File root;
  public Context(File root) { this.root = root; }
  public Context getApplicationContext() { return this; }
  public File getFilesDir() {
    if (!Thread.currentThread().getName().contains("kinnship-origins")) throw new AssertionError("disk on producer");
    return root;
  }
}
