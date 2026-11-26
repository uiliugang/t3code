package expo.modules.t3nativecontrols

import androidx.annotation.Keep
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.sharedobjects.SharedObject

@Keep
internal object T3Noise {
  init {
    System.loadLibrary("t3_connect_noise")
  }
  external fun open(environment: String, pin: ByteArray): Long
  external fun record(handle: Long, bytes: ByteArray, writing: Boolean): ByteArray
  external fun close(handle: Long)
}

@Keep
internal class ConnectNoisePeer(appContext: AppContext, environment: String, pin: ByteArray) :
  SharedObject(appContext) {
  private val handle = T3Noise.open(environment, pin)
  fun write(bytes: ByteArray) = T3Noise.record(handle, bytes, true)
  fun read(bytes: ByteArray) = T3Noise.record(handle, bytes, false)
  override fun sharedObjectDidRelease() {
    T3Noise.close(handle)
    super.sharedObjectDidRelease()
  }
}
