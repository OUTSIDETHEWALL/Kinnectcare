package expo.modules.startupdiagnostics

import android.util.AtomicFile
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/** Worker-thread-only, private evidence pages. Never opens authority/SDK/battery storage. */
internal class EvidenceStore(filesDir: File) {
  private val directory = File(filesDir, "kinnship_bounded_evidence_v2").apply { mkdirs() }
  var readFailures = 0L
  private fun hourNames(): List<String> = directory.list()?.map {
    it.removeSuffix(".new").removeSuffix(".bak")
  }?.distinct()?.filter { Regex("hour_-?[0-9]{1,14}\\.json").matches(it) } ?: emptyList()
  private fun read(name: String): String? = try {
    val file = File(directory, name)
    if (listOf(file, File("$file.bak"), File("$file.new")).any { it.length() > 131072 }) {
      readFailures++; null
    } else if (!file.exists() && !File("$file.bak").exists()) {
      if (File("$file.new").exists()) readFailures++
      null
    }
    else AtomicFile(file).readFully().toString(Charsets.UTF_8)
  } catch (_: Exception) { readFailures++; null }

  private fun write(name: String, text: String) {
    require(text.length <= 131072)
    val file = AtomicFile(File(directory, name))
    val output = file.startWrite()
    try {
      output.write(text.toByteArray(Charsets.UTF_8))
      file.finishWrite(output)
    } catch (error: Exception) { file.failWrite(output); throw error }
  }

  fun load(): Pair<JSONArray, JSONArray> {
    fun rows(prefix: String, pages: Int): JSONArray {
      val values = mutableListOf<JSONObject>()
      repeat(pages) { page -> try {
        val rows = JSONArray(read("${prefix}_$page.json") ?: "[]")
        for (i in 0 until minOf(rows.length(), 32)) {
          val row = rows.getJSONObject(i)
          if (row.getLong("ordinal") >= 0 && row.getLong("ordinal") < Long.MAX_VALUE - 2048)
            values.add(row)
        }
      } catch (_: Exception) { readFailures++ } }
      return JSONArray(values.sortedBy { it.getLong("ordinal") })
    }
    return rows("http", 16) to rows("gps", 64)
  }

  fun loadHours(validKey: (String) -> Boolean): JSONObject {
    val result = JSONObject()
    val names = hourNames()
    val sorted = names.sortedBy { it.removePrefix("hour_").removeSuffix(".json").toLong() }
    sorted.dropLast(48).forEach { AtomicFile(File(directory, it)).delete() }
    sorted.takeLast(48).forEach { name -> try {
      val raw = JSONObject(read(name) ?: "{}")
      val clean = JSONObject()
      for (key in raw.keys().asSequence().take(257)) {
        if (key.length <= 100 && validKey(key)) {
          val count = raw.getLong(key)
          if (count >= 0) clean.put(key, count)
        }
      }
      result.put(name.removePrefix("hour_").removeSuffix(".json"), clean)
    } catch (_: Exception) { readFailures++ } }
    return result
  }

  fun loadLoss(): Long = try { JSONObject(read("loss.json") ?: "{}").optLong("queueDropped", 0).coerceAtLeast(0) }
    catch (_: Exception) { readFailures++; 0 }

  fun save(http: JSONArray, gps: JSONArray, hours: JSONObject, dirtyHttp: Set<Int>, dirtyGps: Set<Int>,
    dirtyHours: Set<String>, dropped: Long) {
    // Dirty sets stay bounded even if writes fail for days. Stale page removal
    // is reconciled from the finite disk inventory, not an unbounded tombstone set.
    hourNames().forEach { name ->
      if (!hours.has(name.removePrefix("hour_").removeSuffix(".json"))) AtomicFile(File(directory, name)).delete()
    }
    fun pages(prefix: String, rows: JSONArray, count: Int, dirty: Set<Int>) {
      for (page in dirty) {
        val selected = JSONArray()
        for (i in 0 until rows.length()) {
          val row = rows.getJSONObject(i)
          if ((row.getLong("ordinal") / 32 % count).toInt() == page) selected.put(row)
        }
        write("${prefix}_$page.json", selected.toString())
      }
    }
    pages("http", http, 16, dirtyHttp)
    pages("gps", gps, 64, dirtyGps)
    for (hour in dirtyHours) {
      if (hours.has(hour)) write("hour_$hour.json", hours.getJSONObject(hour).toString())
      else AtomicFile(File(directory, "hour_$hour.json")).delete()
    }
    if (dropped != loadLoss()) write("loss.json", JSONObject().put("queueDropped", dropped).toString())
  }
}
