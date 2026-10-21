package expo.modules.startupdiagnostics
import android.content.Context
/** Only the pre-existing verbose observer is substituted in the runtime harness. */
object EvidenceTrace {
  @JvmStatic fun install(context: Context) {}
  @JvmStatic fun record(context: Context, channel: String, stage: String, id: String, detail: String) {}
  @JvmStatic fun httpStatus(status: String) {}
}
