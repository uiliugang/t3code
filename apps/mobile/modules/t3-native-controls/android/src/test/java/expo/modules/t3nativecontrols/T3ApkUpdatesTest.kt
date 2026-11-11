package expo.modules.t3nativecontrols

import org.junit.Assert.assertThrows
import org.junit.Test

class T3ApkUpdatesTest {
  private val installed = ApkUpdateIdentity("com.example.app", 7, setOf("certificate"))

  @Test
  fun acceptsANewerApkWithTheSamePackageAndCertificate() {
    requireCompatibleApkUpdate(installed, installed.copy(versionCode = 8), 8)
  }

  @Test
  fun rejectsAnotherPackageOrSigningCertificate() {
    for (candidate in listOf(
      installed.copy(packageName = "com.other.app", versionCode = 8),
      installed.copy(versionCode = 8, signatures = setOf("other certificate")),
      installed.copy(versionCode = 8, signatures = emptySet()),
    )) {
      assertThrows(IllegalArgumentException::class.java) {
        requireCompatibleApkUpdate(installed, candidate, 8)
      }
    }
  }

  @Test
  fun rejectsDowngradesAndVersionsThatDifferFromTheManifest() {
    for (version in listOf(6L, 7L, 9L)) {
      assertThrows(IllegalArgumentException::class.java) {
        requireCompatibleApkUpdate(installed, installed.copy(versionCode = version), 8)
      }
    }
  }
}
