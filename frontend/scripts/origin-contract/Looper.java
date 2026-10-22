package android.os;
import java.util.concurrent.*;
public class Looper {
  final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(r -> {
    Thread t = new Thread(r, "kinnship-origins-test"); t.setDaemon(true); return t;
  });
}
