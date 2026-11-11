package expo.modules.startupdiagnostics

import org.json.JSONArray
import org.json.JSONObject

/** Worker-only bounded state. Late success never unpins an incident. */
internal class SchedulingRetention {
  private val timers = linkedMapOf<String, JSONObject>()
  private val incidents = linkedMapOf<String, JSONObject>()
  private val lifecycle = ArrayDeque<JSONObject>()
  private val bins = linkedMapOf<String, JSONObject>()
  private val latestState = linkedMapOf<String, JSONObject>()
  var overflow = 0L
  var restoreFailures = 0L
  var nativeReadFailures = 0L
  var writeFailures = 0L
  var captureFailures = 0L
  var exportOverflows = 0L
  private val threshold = 120000000000L
  private fun key(e: JSONObject) =
    "${e.optString("process")}:${e.optString("js")}:${e.optLong("registration")}"
  fun accept(e: JSONObject) {
    val stage = e.optInt("stage")
    if (stage in listOf(1, 2, 3, 4, 5, 6, 7, 13, 20)) {
      val stateKey = "${e.optString("process")}:$stage:${e.optLong("manager")}"
      latestState[stateKey] = e
      while (latestState.size > 64) latestState.remove(latestState.keys.first())
      lifecycle.addLast(e)
      while (lifecycle.size > 64) { lifecycle.removeFirst(); overflow++ }
      incidents.values.forEach { capsule ->
        val release = capsule.getJSONArray("release")
        release.put(e)
        if (release.length() > 32) { release.remove(0); capsule.put("releaseOverflow", true) }
      }
    }
    val registration = e.optLong("registration")
    if (registration <= 0) return
    val id = key(e)
    var row = timers[id]
    if (row == null) {
      if (timers.size >= 128) {
        val victim = timers.entries.firstOrNull { it.value.optBoolean("terminal") && !it.value.optBoolean("pinned") }
        if (victim == null) { overflow++; return }
        timers.remove(victim.key)
      }
      val before = latestState.values.groupBy { it.optInt("stage") }.values.map { states ->
        states.lastOrNull { e.optLong("runtime") != 0L && it.optLong("runtime") == e.optLong("runtime") }
          ?: states.last()
      }.take(12)
      row = JSONObject().put("id", id).put("creation", e)
        .put("beforeGap", JSONArray(before))
      timers[id] = row
    }
    // Immutable first occurrence of each critical scheduling boundary.
    val field = "stage$stage"
    if (!row.has(field)) row.put(field, e)
    row.put("last", e)
    if (stage == 12 || stage == 17 || (stage == 4 && e.optInt("state") == 2)) row.put("terminal", true)
    if (e.optLong("elapsedNs") - row.getJSONObject("creation").optLong("elapsedNs") >= threshold) pin(row)
  }
  fun compact() {
    val ordinary = timers.filterValues { it.optBoolean("terminal") && !it.optBoolean("pinned") }.keys.toList()
    ordinary.forEach { timers.remove(it); overflow++ }
    while (bins.size > 60) { bins.remove(bins.keys.first()); overflow++ }
  }
  fun dropSummaryBins() {
    overflow += bins.size
    bins.clear()
  }
  fun summary(process: String, now: Long, counters: JSONArray) {
    val key = "$process:${now / 60000000000L}"
    bins[key] = JSONObject().put("process", process).put("elapsedNs", now)
      .put("scope", "native_runtime_ids_zero_is_unbound").put("counters", counters)
    while (bins.size > 120) bins.remove(bins.keys.first())
  }
  /** Pin safe deep-evidence projections beside each incident, including one follower. */
  fun correlate(entities: Collection<JSONObject>) {
    for (capsule in incidents.values) {
      val timers = capsule.getJSONArray("timers")
      if (timers.length() == 0) continue
      val first = timers.getJSONObject(0).getJSONObject("creation")
      val flight = first.optString("flight")
      val operation = first.optString("operation")
      val follower = entities.firstOrNull { it.optString("kind") == "operation" &&
        flight.isNotEmpty() && it.optString("flight") == flight && it.optString("id") != operation }
      val followerId = follower?.optString("id").orEmpty()
      val wanted = entities.filter { row ->
        val kind = row.optString("kind")
        (kind == "flight" && flight.isNotEmpty() && row.optString("id") == flight) ||
          (kind == "operation" && row.optString("id") in listOf(operation, followerId)) ||
          (kind == "request" && row.optString("operation") == operation)
      }.take(8)
      val references = capsule.optJSONObject("references") ?: JSONObject().also { capsule.put("references", it) }
      for (row in wanted) {
        val id = "${row.optString("kind")}:${row.optString("id")}"
        if (!references.has(id) && references.length() >= 8) { overflow++; continue }
        val projection = JSONObject()
        for (field in listOf("kind", "id", "operation", "flight", "origin", "process",
            "context", "startedElapsed", "startedWall", "last", "settled")) {
          if (row.has(field)) projection.put(field, row.get(field))
        }
        val history = row.optJSONArray("history") ?: JSONArray()
        val bounded = JSONArray()
        // Preserve native/request receipt and aggregate stages, not payloads.
        for (i in 0 until history.length()) {
          val item = history.getJSONObject(i)
          if (i == 0 || item.optString("stage") in setOf("native_request_bound", "native_ended",
              "xhr_response_received", "fetch_callback_scheduled", "fetch_callback_executed",
              "aggregate_fulfilled", "aggregate_rejected", "flight_created", "map_removed",
              "consumer_attached", "authorization_published")) bounded.put(item)
        }
        projection.put("history", bounded)
        val retained = references.optJSONObject(id) ?: JSONObject().put("first", projection).also { references.put(id, it) }
        retained.put("latest", projection)
      }
      capsule.put("followerRetained", capsule.optBoolean("followerRetained") ||
        (followerId.isNotEmpty() && references.has("operation:$followerId")))
    }
  }
  private fun pin(row: JSONObject) {
    val creation = row.getJSONObject("creation")
    val flight = creation.optString("flight").ifEmpty { creation.optString("request") }
    val root = "${creation.optString("process")}:$flight"
    val existing = incidents[root]
    if (existing == null && incidents.size >= 4) { overflow++; return }
    val capsule = existing ?: JSONObject().put("id", root).put("before", JSONArray(lifecycle.toList()))
      .put("timers", JSONArray()).put("release", JSONArray()).also { incidents[root] = it }
    val members = capsule.getJSONArray("timers")
    if (!row.optBoolean("pinned")) {
      if (members.length() >= 6) { overflow++; return }
      members.put(row); row.put("pinned", true)
    }
  }
  fun export(now: Long, currentProcess: String? = null): JSONObject {
    timers.values.forEach {
      if (!it.optBoolean("terminal") && (currentProcess == null ||
          it.getJSONObject("creation").optString("process") == currentProcess) &&
        now - it.getJSONObject("creation").optLong("elapsedNs") >= threshold) pin(it)
    }
    return JSONObject().put("timers", JSONArray(timers.values.toList()))
      .put("incidents", JSONArray(incidents.values.toList())).put("lifecycle", JSONArray(lifecycle.toList()))
      .put("bins", JSONArray(bins.values.toList())).put("overflow", overflow)
      .put("restoreFailures", restoreFailures).put("nativeReadFailures", nativeReadFailures)
      .put("writeFailures", writeFailures).put("captureFailures", captureFailures)
      .put("exportOverflows", exportOverflows).put("lastCaptureElapsedNs", now)
  }
  fun restore(saved: JSONObject) {
    val restored = saved.optJSONArray("timers") ?: JSONArray()
    for (i in 0 until minOf(128, restored.length())) {
      val row = restored.getJSONObject(i)
      row.put("priorProcessRecord", true).put("terminal", true)
      timers[row.getString("id")] = row
    }
    val capsules = saved.optJSONArray("incidents") ?: JSONArray()
    for (i in 0 until minOf(4, capsules.length())) {
      val capsule = capsules.getJSONObject(i)
      val members = capsule.optJSONArray("timers") ?: JSONArray()
      val linked = JSONArray()
      for (j in 0 until minOf(6, members.length())) {
        val member = members.getJSONObject(j)
        val id = member.optString("id")
        if (!timers.containsKey(id) && timers.size < 128) {
          member.put("priorProcessRecord", true).put("terminal", true)
          timers[id] = member
        }
        timers[id]?.let { linked.put(it) }
      }
      capsule.put("timers", linked)
      incidents[capsule.getString("id")] = capsule
    }
  }
}
