package expo.modules.t3agentnotifications

import android.app.NotificationChannel
import android.app.Notification
import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import java.security.MessageDigest
import java.util.UUID

class AgentMessagingService : ExpoFirebaseMessagingService() {
  override fun handleIntent(intent: Intent) {
    // Firebase otherwise displays notification payloads before onMessageReceived runs.
    if (intent.action == "com.google.android.c2dm.intent.RECEIVE" ||
      intent.action == "com.google.firebase.messaging.RECEIVE_DIRECT_BOOT"
    ) {
      val type = intent.getStringExtra("message_type")
      if (type == null || type == "gcm") {
        val message = RemoteMessage(intent.extras ?: return)
        if (message.notification != null || !ActivityWake.isWake(message.data)) return
      }
    }
    super.handleIntent(intent)
  }

  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    if (remoteMessage.notification == null) ActivityWake.enqueue(this, remoteMessage.data)
  }
}

class NotificationUpgradeReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action ==
      Intent.ACTION_MY_PACKAGE_REPLACED
    ) {
      AgentNotifications.disableDelegation(context)
    }
  }
}

class AgentActivityDismissReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    AgentNotifications.dismiss(context, intent.data?.lastPathSegment)
  }
}

class AgentActivityExpiryReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    AgentNotifications.expire(context, scope = intent.data?.lastPathSegment)
  }
}

/** Owns local presentation, registration and dismissal across app restarts. */
object AgentNotifications {
  private const val STORE = "t3-agent-notifications"
  private const val ACTIVITY_CHANNEL = "agent-activity"
  private const val ALERT_CHANNEL = "agent-alerts"
  private const val ACTIVITY_TAG = "t3-agent-activity"
  private const val ALERT_TAG = "t3-agent-alert"
  private const val ACTIVITY_ID = 73001
  private const val MAX_MESSAGE_AGE_MS = 10 * 60 * 1000L
  private const val RUNNING_LIFETIME_MS = 2 * 60 * 60 * 1000L
  private const val MAX_LIFETIME_MS = 24 * 60 * 60 * 1000L

  // Existing installations may still have a delegated presenter from an older Firebase build.
  fun disableDelegation(context: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val manager = manager(context)
      if (manager.notificationDelegate ==
        "com.google.android.gms"
      ) {
        manager.notificationDelegate = null
      }
    }
  }

  @Synchronized
  fun configure(
    context: Context,
    deviceId: String,
    userId: String,
    scheme: String,
    ongoingEnabled: Boolean
  ) {
    disableDelegation(context)
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    // JS identity is empty on a cold start. Compare the durable identity here
    // so reopening preserves cards, dismissal and replay history for this user.
    if (prefs.getString("userId", null) != userId ||
      prefs.getString("deviceId", null) != deviceId
    ) {
      clear(context)
    }
    val wasEnabled = prefs.getBoolean("ongoing", false)
    prefs.edit().putString(
      "deviceId",
      deviceId
    ).putString("userId", userId).putString("scheme", scheme)
      .putBoolean("enabled", true).putBoolean("ongoing", ongoingEnabled).apply()
    if (ongoingEnabled && !wasEnabled) prefs.edit().putBoolean("dismissed", false).apply()
    if (!prefs.contains("registration")) {
      prefs.edit().putString("registration", UUID.randomUUID().toString()).apply()
    }
    prefs.getStringSet("wakeScopes", emptySet()).orEmpty().forEach { scope ->
      if (!ongoingEnabled) cancelActivity(context, scope)
      if (ongoingEnabled &&
        !wasEnabled
      ) {
        state(context, scope).edit().putBoolean("dismissed", false).apply()
      }
    }
    if (!ongoingEnabled) cancelActivity(context)
    channels(context)
  }

  @Synchronized
  fun clear(context: Context) {
    cancelActivity(context)
    val prefs = state(context, null)
    prefs.getStringSet("wakeScopes", emptySet()).orEmpty().forEach { scope ->
      cancelActivity(context, scope)
      state(context, scope).edit().clear().apply()
    }
    prefs.edit().clear().apply()
    val manager = manager(context)
    manager.activeNotifications.filter {
      it.tag == ACTIVITY_TAG || it.tag == ALERT_TAG ||
        it.tag?.startsWith("$ALERT_TAG-summary:") == true
    }
      .forEach { manager.cancel(it.tag, it.id) }
  }

  @Volatile private var threadOnScreen: String? = null

  fun setThreadOnScreen(path: String?) {
    threadOnScreen = path
  }

  @Synchronized
  fun dismiss(context: Context, scope: String? = null) {
    state(context, scope).edit().putBoolean("dismissed", true).apply()
    cancelActivity(context, scope)
  }

  @Synchronized
  fun expire(context: Context, now: Long = System.currentTimeMillis(), scope: String? = null) {
    val expiresAt = state(context, scope).getLong("expiresAt", 0)
    // An already-dispatched alarm must not remove a newer run's card.
    if (expiresAt > 0 && expiresAt <= now) cancelActivity(context, scope)
  }

  private fun state(context: Context, scope: String?): SharedPreferences =
    context.getSharedPreferences(scope?.let { "$STORE.$it" } ?: STORE, Context.MODE_PRIVATE)

  @Synchronized
  fun wakeRegistration(context: Context, userId: String, deviceId: String): String? {
    val prefs = state(context, null)
    val matches =
      prefs.getString("deviceId", null) == deviceId && prefs.getString("userId", null) == userId
    if (!matches || !prefs.getBoolean("enabled", false) ||
      !NotificationManagerCompat.from(context).areNotificationsEnabled()
    ) {
      return null
    }
    return prefs.getString("registration", null)
  }

  @Synchronized
  fun displayWake(
    context: Context,
    environmentId: String,
    registrationId: String,
    card: Map<String, String>,
    alerts: List<Map<String, String>>
  ) {
    val registration = state(context, null)
    if (registration.getString("registration", null) != registrationId ||
      !NotificationManagerCompat.from(context).areNotificationsEnabled()
    ) {
      return
    }
    val scope = Base64.encodeToString(
      MessageDigest.getInstance("SHA-256").digest(environmentId.toByteArray()),
      Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
    )
    val scopes = registration.getStringSet("wakeScopes", emptySet()).orEmpty()
    if (scope !in scopes) registration.edit().putStringSet("wakeScopes", scopes + scope).apply()
    val prefs = state(context, scope)
    val scheme = registration.getString("scheme", "t3code") ?: "t3code"
    channels(context)
    var covered: String? = null
    for (alert in alerts) {
      if (showAlert(context, prefs, scheme, alert)) covered = alert["alert_path"]
    }
    val data = if (covered == null) card else card + ("alert_path" to covered)
    updateActivity(context, data, System.currentTimeMillis(), covered != null, scope)
  }

  @Synchronized
  fun receive(context: Context, data: Map<String, String>) {
    val prefs = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    val updatedAt = data["updated_at"]?.toLongOrNull() ?: return
    val registered = prefs.getBoolean("enabled", false) &&
      data["device_id"] == prefs.getString("deviceId", null) &&
      data["user_id"] == prefs.getString("userId", null)
    val fresh = System.currentTimeMillis() - updatedAt in -MAX_MESSAGE_AGE_MS..MAX_MESSAGE_AGE_MS
    if (registered && fresh && NotificationManagerCompat.from(context).areNotificationsEnabled()) {
      channels(context)
      val scheme = prefs.getString("scheme", "t3code") ?: "t3code"
      val alerted = showAlert(context, prefs, scheme, data)
      updateActivity(context, data, updatedAt, alerted)
    }
  }

  private fun showAlert(
    context: Context,
    prefs: SharedPreferences,
    scheme: String,
    data: Map<String, String>
  ): Boolean {
    // Queue retries carry the same alert id. Keep a bounded history even when
    // notification A is retried after notification B has already arrived.
    val alertId = data["alert_id"]
    val seen = prefs.getString("seenAlertsOrdered", null)?.split('\n')
      ?: prefs.getStringSet("seenAlerts", emptySet()).orEmpty().toList()
    if (alertId != null && alertId !in seen) {
      // Consume suppressed alerts so retries cannot resurface them later.
      val resumed = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(
        Lifecycle.State.RESUMED
      )
      val visibleThread = threadOnScreen
      val onScreen = resumed && visibleThread != null && data["alert_path"] == visibleThread
      if (!onScreen) {
        postAlert(context, scheme, data, alertId)
      }
      prefs.edit().remove("seenAlerts").putString(
        "seenAlertsOrdered",
        (seen.takeLast(63) + alertId).joinToString("\n")
      ).apply()
      // Android drops posts to a blocked channel, so that alert shows nothing.
      return !onScreen && (
        Build.VERSION.SDK_INT < 26 ||
          manager(context).getNotificationChannel(ALERT_CHANNEL)?.importance !=
          NotificationManager.IMPORTANCE_NONE
        )
    }
    return false
  }

  private fun postAlert(
    context: Context,
    scheme: String,
    data: Map<String, String>,
    alertId: String
  ) {
    val title = data["alert_title"].orEmpty().take(120)
    // Grouped alerts list up to five 120-character thread titles.
    val body = data["alert_body"].orEmpty().take(608)
    val id = alertId.hashCode()
    val group = data["alert_group"]?.takeIf { it.isNotBlank() } ?: ALERT_TAG
    val notification = base(context, ALERT_CHANNEL)
      .setContentTitle(title).setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setAutoCancel(true)
      .setGroup(group)
      .setContentIntent(contentIntent(context, scheme, data["alert_path"], id))
      .build()
    manager(context).notify(ALERT_TAG, id, notification)
    val children = manager(context).activeNotifications.filter {
      it.tag == ALERT_TAG && it.notification.group == group
    }
    if (children.size > 1) {
      val style = NotificationCompat.InboxStyle()
      children.forEach {
        style.addLine(it.notification.extras.getCharSequence(android.app.Notification.EXTRA_TEXT))
      }
      val summary = base(context, ALERT_CHANNEL)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(style)
        .setGroup(group)
        .setGroupSummary(true)
        .setSilent(true)
        .setAutoCancel(true)
        .setContentIntent(contentIntent(context, scheme, data["alert_path"], 0))
        .build()
      manager(context).notify("$ALERT_TAG-summary:$group", 0, summary)
    }
  }

  /**
   * Renders a relay-shaped payload without the registration, freshness and
   * foreground checks, for the showcase capture's staged notifications.
   */
  @Synchronized
  fun showcase(context: Context, scheme: String, data: Map<String, String>) {
    channels(context)
    data["alert_id"]?.let { postAlert(context, scheme, data, it) }
    showActivity(context, scheme, data, RUNNING_LIFETIME_MS)
  }

  private fun updateActivity(
    context: Context,
    data: Map<String, String>,
    updatedAt: Long,
    alerted: Boolean,
    scope: String? = null
  ) {
    val prefs = state(context, scope)
    val terminal = singleTerminal(data)
    // Only a one-row card on the alert's own thread is known to show nothing more
    // than the alert. Grouped alerts and cards with other rows stay visible.
    val covered = terminal?.takeIf { alerted && data["alert_path"] == data["activity_path"] }
    if (covered != null) coverTerminal(prefs, covered, updatedAt)
    if (updatedAt < prefs.getLong("lastUpdate", 0)) {
      // A newer replay of this same finish may already show the card.
      if (isCovered(prefs, prefs.getString("lastTerminal", null))) cancelActivity(context, scope)
      return
    }
    prefs.edit().putLong("lastUpdate", updatedAt).putString("lastTerminal", terminal).apply()
    val active = data["active"] == "true"
    // Use absolute state expiry: a replay must not extend a finished card or
    // make an abandoned host look active indefinitely. Older relays omit it.
    val expiresAt = data["activity_expires_at"]?.toLongOrNull()
      ?: if (active) updatedAt + RUNNING_LIFETIME_MS else 0L
    val remainingMs = (expiresAt - System.currentTimeMillis()).coerceAtMost(MAX_LIFETIME_MS)
    val wasActive = prefs.getBoolean("lastActive", false)
    prefs.edit().putBoolean("lastActive", active).apply()
    if (remainingMs <= 0 || !state(context, null).getBoolean("ongoing", false)) {
      cancelActivity(context, scope)
      prefs.edit().putBoolean("dismissed", false).apply()
      return
    }
    // Dismissing a run includes its finished card. A new run, or toggling
    // activity off/on, arms it again; terminal replays stay dismissed.
    if (active && !wasActive) prefs.edit().putBoolean("dismissed", false).apply()
    if (prefs.getBoolean("dismissed", false) || isCovered(prefs, terminal)) {
      cancelActivity(context, scope)
    } else {
      val scheme = state(context, null).getString("scheme", "t3code") ?: "t3code"
      showActivity(context, scheme, data, remainingMs, scope)
    }
  }

  /** Identifies a finished one-thread card by its path, phase and absolute expiry. */
  private fun singleTerminal(data: Map<String, String>): String? {
    val phase = data["activity_phase"]
    val finished = phase == "completed" || phase == "failed"
    val single = data.containsKey("activity_line_0") && !data.containsKey("activity_line_1")
    val expiresAt = data["activity_expires_at"]
    return "${data["activity_path"]}\n$phase\n$expiresAt"
      .takeIf { finished && single && expiresAt != null }
  }

  private fun isCovered(prefs: SharedPreferences, terminal: String?) =
    terminal != null && terminal == prefs.getString("coveredTerminal", null)

  private fun coverTerminal(prefs: SharedPreferences, terminal: String?, updatedAt: Long) {
    if (updatedAt >= prefs.getLong("lastUpdate", 0) ||
      prefs.getString("lastTerminal", null) == terminal
    ) {
      prefs.edit().putString("coveredTerminal", terminal).apply()
    }
  }

  private fun showActivity(
    context: Context,
    scheme: String,
    data: Map<String, String>,
    remainingMs: Long,
    scope: String? = null
  ) {
    val dismissIntent = PendingIntent.getBroadcast(
      context,
      ACTIVITY_ID,
      scopedIntent(context, AgentActivityDismissReceiver::class.java, scope),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val active = data["active"] == "true"
    val presentation = ActivityPresentation(data, active)
    val openThread = contentIntent(
      context,
      scheme,
      data["activity_path"],
      scope?.hashCode() ?: ACTIVITY_ID
    )
    // Retained results still need Android's ongoing flag to remain promoted.
    val ongoing = active || Build.VERSION.SDK_INT >= 36
    val builder = base(context, ACTIVITY_CHANNEL)
      .setOngoing(ongoing).setOnlyAlertOnce(true).setSilent(true)
      .setTimeoutAfter(remainingMs)
      // Live Updates must remain uncolorized to qualify for promotion.
      .setColorized(false)
      .setRequestPromotedOngoing(ongoing)
      .setShortCriticalText(if (ongoing) presentation.chip else null)
      .setContentIntent(openThread)
      .setDeleteIntent(dismissIntent)
    presentation.applyTo(builder, context)
    val action = presentation.action
    if (action != null && openThread != null) builder.addAction(0, action, openThread)
    if (ongoing) builder.addAction(0, "Dismiss", dismissIntent)
    manager(context).notify(activityTag(scope), ACTIVITY_ID, builder.build())
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      // Notification timeouts were added in API 26. One inexact alarm also
      // expires cards on Android 7, including when the app process has exited.
      // No exact-alarm permission, foreground service or periodic work needed.
      val expiresAt = System.currentTimeMillis() + remainingMs
      state(context, scope).edit().putLong("expiresAt", expiresAt).apply()
      context.getSystemService(
        AlarmManager::class.java
      ).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, expiresAt, expiryIntent(context, scope))
    }
  }

  private fun activityTag(scope: String?) = scope?.let { "$ACTIVITY_TAG:$it" } ?: ACTIVITY_TAG

  private fun scopedIntent(context: Context, target: Class<*>, scope: String?) =
    Intent(context, target).apply {
      scope?.let { data = Uri.parse("t3-notification://activity/$it") }
    }

  private fun expiryIntent(context: Context, scope: String?): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      ACTIVITY_ID,
      scopedIntent(context, AgentActivityExpiryReceiver::class.java, scope),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

  private fun cancelActivity(context: Context, scope: String? = null) {
    manager(context).cancel(activityTag(scope), ACTIVITY_ID)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      context.getSystemService(AlarmManager::class.java).cancel(expiryIntent(context, scope))
      state(context, scope).edit().remove("expiresAt").apply()
    }
  }

  private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)

  private fun channels(context: Context) {
    if (Build.VERSION.SDK_INT >= 26) {
      manager(context).createNotificationChannels(
        listOf(
          NotificationChannel(ALERT_CHANNEL, "Agent alerts", NotificationManager.IMPORTANCE_HIGH),
          NotificationChannel(
            ACTIVITY_CHANNEL,
            "Ongoing agent activity",
            NotificationManager.IMPORTANCE_LOW
          ),
        )
      )
    }
  }

  private fun base(context: Context, channel: String): NotificationCompat.Builder =
    NotificationCompat.Builder(context, channel)
      .setPriority(
        if (channel ==
          ALERT_CHANNEL
        ) {
          NotificationCompat.PRIORITY_HIGH
        } else {
          NotificationCompat.PRIORITY_LOW
        }
      )
      .setDefaults(if (channel == ALERT_CHANNEL) Notification.DEFAULT_ALL else 0)
      .setSmallIcon(R.drawable.agent_activity_mark)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setShowWhen(false)

  private fun contentIntent(
    context: Context,
    scheme: String,
    path: String?,
    id: Int
  ): PendingIntent? {
    val threadPath = path?.takeIf { it.startsWith("/threads/") }
    val route = threadPath?.takeUnless { it.contains('?') || it.contains('#') } ?: "/"
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?: return null
    intent.setAction(Intent.ACTION_VIEW).setData(Uri.parse("$scheme:/$route"))
      .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      id,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }
}
