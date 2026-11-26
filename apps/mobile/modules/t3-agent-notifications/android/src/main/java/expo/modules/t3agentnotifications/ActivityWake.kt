package expo.modules.t3agentnotifications

import android.content.Context
import android.os.Build
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** WorkManager can start the JS runtime after process death without opening an Activity. */
class ActivityWake(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
  private val task = UUID.randomUUID().toString()
  private val finished = CountDownLatch(1)
  private var fetched = false

  override fun doWork(): Result {
    val environment = inputData.getString("environment_id").orEmpty()
    val user = inputData.getString("user_id").orEmpty()
    val device = inputData.getString("device_id").orEmpty()
    val host = (applicationContext as ReactApplication).reactHost
    return when {
      !registered(user, device) || expired() -> Result.success()
      host == null -> Result.failure()
      else -> fetch(host, environment, user, device)
    }
  }

  private fun fetch(host: ReactHost, environment: String, user: String, device: String): Result {
    val boot = host.start()
    if (!boot.waitForCompletion(40, TimeUnit.SECONDS) || boot.isFaulted() ||
      isStopped
    ) {
      return retry()
    }
    val react = host.currentReactContext
    try {
      if (react != null) {
        running[task] = this
        startTask(react, environment, user, device)
        finished.await(45, TimeUnit.SECONDS)
      }
    } finally {
      running.remove(task, this)
    }
    return if (fetched) Result.success() else retry()
  }

  private fun startTask(react: ReactContext, environment: String, user: String, device: String) {
    UiThreadUtil.runOnUiThread {
      if (!isStopped && running[task] === this) {
        val args = Arguments.createMap().apply {
          putString("task", task)
          putString("environmentId", environment)
          putString("userId", user)
          putString("deviceId", device)
        }
        HeadlessJsTaskContext.getInstance(react).startTask(
          HeadlessJsTaskConfig("T3AgentActivityWake", args, 45_000, true)
        )
      }
    }
  }

  override fun onStopped() {
    running.remove(task, this)
    finished.countDown()
    super.onStopped()
  }

  private fun expired() =
    System.currentTimeMillis() - inputData.getLong("received_at", 0) !in 0..600_000

  private fun retry() = if (!expired() && runAttemptCount < 2) Result.retry() else Result.failure()

  private fun registered(user: String, device: String) =
    AgentNotifications.wakeRegistration(applicationContext, user, device) ==
      inputData.getString("registration") && inputData.getString("registration") != null

  companion object {
    private val fields = setOf("t3_kind", "environment_id", "device_id", "user_id")
    private val running = ConcurrentHashMap<String, ActivityWake>()

    internal fun isWake(data: Map<String, String>) =
      data.keys == fields && data["t3_kind"] == "agent_activity_wake" &&
        listOf("environment_id", "device_id", "user_id").all {
          val value = data[it].orEmpty()
          value.isNotBlank() && value.length <= 256
        }

    fun enqueue(context: Context, data: Map<String, String>) {
      if (!isWake(data)) return
      val env = data.getValue("environment_id")
      val user = data.getValue("user_id")
      val device = data.getValue("device_id")
      val registration = AgentNotifications.wakeRegistration(context, user, device) ?: return
      val work = OneTimeWorkRequestBuilder<ActivityWake>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setInputData(
          workDataOf(
            "environment_id" to env,
            "user_id" to user,
            "device_id" to device,
            "registration" to registration,
            "received_at" to System.currentTimeMillis()
          )
        )
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        work.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
      }
      WorkManager.getInstance(context).enqueueUniqueWork(
        "t3-activity:$registration:$env",
        ExistingWorkPolicy.REPLACE,
        work.build()
      )
    }

    fun complete(task: String, card: Map<String, String>?, alerts: List<Map<String, String>>) {
      val worker = running.remove(task) ?: return
      try {
        if (!worker.isStopped && !worker.expired() && card != null) {
          with(worker) {
            AgentNotifications.displayWake(
              applicationContext,
              inputData.getString("environment_id")!!,
              inputData.getString("registration")!!,
              card,
              alerts
            )
            fetched = true
          }
        }
      } finally {
        worker.finished.countDown()
      }
    }
  }
}
