package expo.modules.startupdiagnostics

import android.content.Context

/** Contract-only recorder substitute. This suite tests authority, not IO/observers. */
object EvidenceTrace {
  fun record(context: Context, channel: String, stage: String, id: String, detail: String) = Unit
}
