package android.os;
import java.util.concurrent.*;
public class Handler {
  private final Looper looper;
  public static volatile CountDownLatch block;
  public Handler(Looper looper) { this.looper = looper; }
  public boolean post(Runnable r) {
    looper.executor.execute(() -> {
      CountDownLatch gate = block;
      if (gate != null) try { gate.await(); } catch (InterruptedException ignored) {}
      r.run();
    }); return true;
  }
  public boolean postDelayed(Runnable r, long delay) {
    looper.executor.schedule(r, delay, TimeUnit.MILLISECONDS); return true;
  }
}
