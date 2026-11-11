import android.os.SystemClock
import expo.modules.startupdiagnostics.HeadlessTaskLifetimes as Lifetimes
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import com.transistorsoft.rnbackgroundgeolocation.KinnshipTaskLifetimeBridge as Bridge
import java.io.File

fun main(args: Array<String>) {
  val priorProcess = args.firstOrNull()?.let(::File)
  if (priorProcess?.exists() == true) check(!Lifetimes.current(priorProcess.readText()))
  SystemClock.now = 1000
  val active = Lifetimes.begin(120000) { true }
  check(Lifetimes.current(active))
  SystemClock.now = 120999
  check(Lifetimes.current(active))
  SystemClock.now = 121000
  check(!Lifetimes.current(active)) // No JS timer or native timeout callback required.
  SystemClock.now = 1000
  check(!Lifetimes.current(active)) // A late query/clock change cannot resurrect it.
  check(Lifetimes.begin(0) { true }.isEmpty())
  check(!Lifetimes.current("previous-process-or-missing-token"))
  println("PASS finite monotonic deadline, boundary, terminal expiry and missing/process identity")

  var rnRunning = true
  val canceled = Lifetimes.begin(120000) { rnRunning }
  check(Lifetimes.current(canceled))
  rnRunning = false
  check(!Lifetimes.current(canceled))
  rnRunning = true
  check(!Lifetimes.current(canceled))
  println("PASS real RN-liveness predicate cancellation is terminal before removal delivery")

  val tokens = (1..30).map { Lifetimes.begin(120000) { true } }
  check(tokens.toSet().size == 30 && tokens.all(Lifetimes::current))
  tokens.take(15).forEach(Lifetimes::end)
  check(tokens.take(15).none(Lifetimes::current))
  check(tokens.drop(15).all(Lifetimes::current))
  val replacement = Lifetimes.begin(120000) { true }
  check(replacement !in tokens)
  check(!Lifetimes.current(tokens.first()) && Lifetimes.current(replacement))
  priorProcess?.writeText(replacement)
  println("PASS independent tasks, removal, replacement, late query and cross-process token rejection")

  // Exercise the actual generated vendor reflection bridge, not a direct-only call.
  val reflected = Bridge.begin(120000) { true }
  check(reflected.isNotEmpty() && Lifetimes.current(reflected))
  Bridge.end(reflected)
  check(!Lifetimes.current(reflected))
  println("PASS generated Java bridge resolves production Kotlin static methods")

  // A currentness query must not hold the registry lock while calling RN.
  val entered = CountDownLatch(1)
  val release = CountDownLatch(1)
  val blocked = Lifetimes.begin(120000) {
    entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); true
  }
  val result = AtomicBoolean(true)
  val query = Thread { result.set(Lifetimes.current(blocked)) }
  query.start()
  check(entered.await(5, TimeUnit.SECONDS))
  val ended = CountDownLatch(1)
  val remover = Thread { Lifetimes.end(blocked); ended.countDown() }
  remover.start()
  val removedWithoutBlocking = ended.await(2, TimeUnit.SECONDS)
  release.countDown()
  query.join(5000); remover.join(5000)
  check(removedWithoutBlocking && !query.isAlive && !result.get())
  println("PASS blocked RN checker cannot block removal or resurrect a removed execution")
  println("LIMIT: JVM clock/RN/logger substitutes are not Android scheduling or phone acceptance")
}
