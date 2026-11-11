package expo.modules.t3nativecontrols

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URI
import java.security.MessageDigest

class T3ApkUpdatesModule : Module() {
  @Suppress("TooGenericExceptionCaught") // Reject the promise if the Activity callback fails.
  override fun definition() = ModuleDefinition {
    Name("T3ApkUpdates")
    AsyncFunction("installApkUpdate") {
        uri: String,
        versionCode: Double,
        sha256: String,
        requestPermission: Boolean,
        promise: Promise
      ->
      val context = appContext.reactContext ?: error("The app is not active.")
      val file = T3ApkUpdates.verify(context, uri, versionCode, sha256)
      val activity = appContext.currentActivity ?: error("The app is not active.")
      activity.runOnUiThread {
        try {
          promise.resolve(T3ApkUpdates.install(activity, file, requestPermission))
        } catch (error: Exception) {
          promise.reject("ERR_APK_INSTALL", error.message, error)
        }
      }
    }
  }
}

internal data class ApkUpdateIdentity(
  val packageName: String,
  val versionCode: Long,
  val signatures: Set<String>
)

internal fun requireCompatibleApkUpdate(
  installed: ApkUpdateIdentity,
  candidate: ApkUpdateIdentity,
  expectedVersionCode: Long
) {
  require(candidate.packageName == installed.packageName) { "The update is for a different app." }
  require(
    candidate.versionCode == expectedVersionCode && candidate.versionCode > installed.versionCode
  ) {
    "The APK version does not match the update or is not newer than the installed app."
  }
  require(installed.signatures.isNotEmpty() && candidate.signatures == installed.signatures) {
    "The APK signing certificate does not match the installed app."
  }
}

internal object T3ApkUpdates {
  @Suppress("DEPRECATION") // Android 7 and 8 expose signing certificates through GET_SIGNATURES.
  private fun identity(info: PackageInfo) = ApkUpdateIdentity(
    info.packageName,
    if (Build.VERSION.SDK_INT >=
      Build.VERSION_CODES.P
    ) {
      info.longVersionCode
    } else {
      info.versionCode.toLong()
    },
    (
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        info.signingInfo?.apkContentsSigners
      } else {
        info.signatures
      }
      )?.map { it.toCharsString() }?.toSet() ?: emptySet(),
  )

  @Suppress("DEPRECATION") // The int flags overload also supports Android 7 through 12.
  fun verify(context: Context, uri: String, versionCode: Double, sha256: String): File {
    val file = File(URI(uri)).canonicalFile
    require(
      file.parentFile == File(context.cacheDir, "t3-apk-updates").canonicalFile && file.isFile
    ) {
      "The downloaded APK is no longer available."
    }
    require(versionCode.isFinite() && versionCode == versionCode.toLong().toDouble()) {
      "The APK version is invalid."
    }
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().buffered().use { stream ->
      val buffer = ByteArray(64 * 1024)
      var count = stream.read(buffer)
      while (count != -1) {
        digest.update(buffer, 0, count)
        count = stream.read(buffer)
      }
    }
    val actualHash = digest.digest().joinToString("") { "%02x".format(it) }
    require(actualHash.equals(sha256, ignoreCase = true)) { "The APK checksum does not match." }
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      PackageManager.GET_SIGNING_CERTIFICATES
    } else {
      PackageManager.GET_SIGNATURES
    }
    val manager = context.packageManager
    val candidate = manager.getPackageArchiveInfo(file.path, flags)
      ?: error("The downloaded file is not a valid APK.")
    requireCompatibleApkUpdate(
      identity(manager.getPackageInfo(context.packageName, flags)),
      identity(candidate),
      versionCode.toLong(),
    )
    return file
  }

  fun install(activity: Activity, file: File, requestPermission: Boolean): String {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      !activity.packageManager.canRequestPackageInstalls()
    ) {
      if (requestPermission) {
        activity.startActivity(
          Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${activity.packageName}")
          )
        )
      }
      return "permission-required"
    }
    val contentUri = FileProvider.getUriForFile(
      activity,
      "${activity.packageName}.FileSystemFileProvider",
      file
    )
    activity.startActivity(
      Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
    )
    return "installing"
  }
}
