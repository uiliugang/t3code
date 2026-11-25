package expo.modules.t3nativecontrols

import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.sharedobjects.SharedObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicInteger

internal class NoiseMediaListener(context: AppContext) : SharedObject(context) {
  private val server = ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"))
  private val pool = Executors.newCachedThreadPool()
  private val channels = ConcurrentHashMap<Int, Socket>()
  private val inputs = ConcurrentHashMap<Int, InputStream>()
  private val firstLines = ConcurrentHashMap<Int, ByteArray>()
  private val nextId = AtomicInteger()
  private val ready = LinkedBlockingQueue<Int>()
  private val paths = mapOf("asset" to "/api/assets/", "device" to "/api/device-hub/",
    "browser" to "/api/preview-stream/", "tunnel" to "/api/preview/tunnel?")
  private val prefixes = paths.mapValues { "/" + UUID.randomUUID().toString() }
  val origins = prefixes.mapValues { "http://127.0.0.1:${server.localPort}${it.value}" }

  init {
    pool.execute {
      while (!server.isClosed) {
        val socket = runCatching { server.accept() }.getOrNull() ?: break
        if (channels.size >= 32) {
          socket.close()
          continue
        }
        val id = nextId.incrementAndGet()
        channels[id] = socket
        if (server.isClosed) { close(id); break }
        runCatching { pool.execute { admit(id, socket) } }.onFailure { close(id) }
      }
    }
  }

  private fun requestLine(input: InputStream): String {
    val bytes = ByteArrayOutputStream()
    while (bytes.size() < 8192) {
      val b = input.read()
      if (b == 10) return bytes.toString("US-ASCII").removeSuffix("\r")
      require(b in 13..126)
      bytes.write(b)
    }
    error("Invalid HTTP request")
  }

  private fun admit(id: Int, socket: Socket) {
    try {
      socket.soTimeout = 10_000
      val input = socket.getInputStream().buffered()
      inputs[id] = input
      val fields = requestLine(input).split(' ')
      require(fields.size == 3 && fields[2] == "HTTP/1.1")
      val (method, path) = fields
      val entry = prefixes.entries.first { path.startsWith(it.value + paths.getValue(it.key)) }
      val target = path.removePrefix(entry.value)
      firstLines[id] = "$method $target HTTP/1.1\r\n".toByteArray(Charsets.US_ASCII)
      socket.soTimeout = 0
      ready.put(id)
    } catch (_: Exception) { close(id) }
  }

  fun run(promise: Promise, operation: () -> Any?) {
    try {
      pool.execute {
        try { promise.resolve(operation()) }
        catch (error: Exception) { promise.reject("ERR_NOISE_MEDIA", "Media connection closed", error) }
      }
    } catch (error: Exception) { promise.reject("ERR_NOISE_MEDIA", "Media listener closed", error) }
  }

  fun accept(): Int = ready.take()
  fun read(id: Int): ByteArray {
    firstLines.remove(id)?.let { return it }
    val bytes = ByteArray(48 * 1024)
    val count = inputs.getValue(id).read(bytes)
    return if (count < 1) byteArrayOf() else bytes.copyOf(count)
  }
  fun write(id: Int, bytes: ByteArray) { channels.getValue(id).getOutputStream().write(bytes) }
  fun close(id: Int) {
    firstLines.remove(id)
    inputs.remove(id)
    runCatching { channels.remove(id)?.close() }
  }
  override fun sharedObjectDidRelease() {
    server.close()
    channels.keys.forEach { close(it) }
    pool.shutdownNow()
    super.sharedObjectDidRelease()
  }
}
