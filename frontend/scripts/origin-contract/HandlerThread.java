package android.os;
public class HandlerThread extends Thread {
  private final Looper looper = new Looper();
  public HandlerThread(String name, int priority) { super(name); }
  public Looper getLooper() { return looper; }
}
