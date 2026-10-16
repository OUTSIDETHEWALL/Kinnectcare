package android.content;

import java.io.*;
import java.lang.reflect.*;
import java.util.*;

/**
 * JVM TEST SUBSTITUTE, not Android implementation or device proof.
 * Production Kotlin is separately compiled against the real Android API.
 */
public final class Context {
  private final File file;
  private final Properties values = new Properties();
  public Context(File file) throws IOException {
    this.file = file;
    if (file.exists()) try (InputStream in = new FileInputStream(file)) { values.load(in); }
  }
  public Context getApplicationContext() { return this; }
  public SharedPreferences getSharedPreferences(String name, int mode) {
    return (SharedPreferences) Proxy.newProxyInstance(getClass().getClassLoader(),
      new Class<?>[]{SharedPreferences.class}, (proxy, method, args) -> {
        if (method.getName().equals("getString")) return values.getProperty((String)args[0], (String)args[1]);
        if (method.getName().equals("edit")) return editor();
        throw new UnsupportedOperationException(method.getName());
      });
  }
  private SharedPreferences.Editor editor() {
    Map<String, String> changes = new HashMap<>();
    return (SharedPreferences.Editor) Proxy.newProxyInstance(getClass().getClassLoader(),
      new Class<?>[]{SharedPreferences.Editor.class}, (proxy, method, args) -> {
        if (method.getName().equals("putString")) {
          changes.put((String)args[0], (String)args[1]); return proxy;
        }
        if (method.getName().equals("commit")) {
          values.putAll(changes);
          try (OutputStream out = new FileOutputStream(file)) { values.store(out, "JVM test"); }
          return true;
        }
        // In particular, apply() is forbidden: these records require commit().
        throw new UnsupportedOperationException(method.getName());
      });
  }
}
