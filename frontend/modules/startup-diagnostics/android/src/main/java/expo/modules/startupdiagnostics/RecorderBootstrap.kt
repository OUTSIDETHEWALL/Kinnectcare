package expo.modules.startupdiagnostics

import android.content.Context
import java.util.concurrent.atomic.AtomicBoolean

/** Independent Application lifecycle hook; no recording API calls this. */
object RecorderBootstrap {
  private val started = AtomicBoolean()
  @JvmStatic fun start(context: Context) {
    if (!started.compareAndSet(false, true)) return
    try {
      Thread({
        EvidenceTrace.install(context)
        RequestOrigins.install(context)
        DeepAsyncTrace.install(context)
        EvidenceTrace.startWorker()
        RequestOrigins.startWorker()
        DeepAsyncTrace.startWorker()
      }, "kinnship-recorder-bootstrap").apply { isDaemon = true }.start()
    } catch (_: Throwable) { /* unavailable diagnostics must not gate startup */ }
  }
}
