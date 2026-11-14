package com.vega

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

/**
 * In-app updater support: downloads a release APK into the app cache with
 * progress events and hands it to the system package installer.
 * JS face: src/lib/native/AppUpdate.ts
 */
class AppUpdateModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val PROGRESS_EVENT = "VegaAppUpdateProgress"
        private const val UPDATE_DIR = "updates"
    }

    @Volatile private var cancelled = false
    @Volatile private var downloading = false

    private val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .build()
    }

    override fun getName(): String = "AppUpdateModule"

    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    private fun updateDir(): File {
        val dir = File(reactContext.cacheDir, UPDATE_DIR)
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    private fun emitProgress(received: Long, total: Long) {
        val map = Arguments.createMap()
        map.putDouble("received", received.toDouble())
        map.putDouble("total", total.toDouble())
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(PROGRESS_EVENT, map)
    }

    @ReactMethod
    fun getSupportedAbis(promise: Promise) {
        val arr = Arguments.createArray()
        Build.SUPPORTED_ABIS.forEach { arr.pushString(it) }
        promise.resolve(arr)
    }

    @ReactMethod
    fun canInstallPackages(promise: Promise) {
        try {
            val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                reactContext.packageManager.canRequestPackageInstalls()
            } else true
            promise.resolve(ok)
        } catch (e: Exception) {
            promise.resolve(true)
        }
    }

    @ReactMethod
    fun openInstallPermissionSettings(promise: Promise) {
        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + reactContext.packageName),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    /** Downloads [url] to cache/updates/[fileName]; resolves with the file path. */
    @ReactMethod
    fun downloadApk(url: String, fileName: String, promise: Promise) {
        if (downloading) {
            promise.reject("BUSY", "A download is already running")
            return
        }
        downloading = true
        cancelled = false
        Thread {
            val dir = updateDir()
            // Drop older downloaded APKs so the cache never accumulates.
            dir.listFiles()?.forEach { if (it.name != fileName) it.delete() }
            val safeName = File(fileName).name
            val target = File(dir, safeName)
            val part = File(dir, "$safeName.part")
            try {
                val request = Request.Builder().url(url).header("Accept", "application/octet-stream").build()
                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        throw RuntimeException("Server returned HTTP " + response.code)
                    }
                    val body = response.body ?: throw RuntimeException("Empty response")
                    val total = body.contentLength()
                    var received = 0L
                    var lastEmit = 0L
                    body.byteStream().use { input ->
                        FileOutputStream(part).use { output ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                if (cancelled) throw RuntimeException("Download cancelled")
                                val read = input.read(buffer)
                                if (read < 0) break
                                output.write(buffer, 0, read)
                                received += read
                                val now = System.currentTimeMillis()
                                if (now - lastEmit > 250) {
                                    lastEmit = now
                                    emitProgress(received, total)
                                }
                            }
                        }
                    }
                    if (total > 0 && received != total) {
                        throw RuntimeException("Download incomplete")
                    }
                    emitProgress(received, total)
                }
                if (target.exists()) target.delete()
                if (!part.renameTo(target)) throw RuntimeException("Could not save the APK")
                promise.resolve(target.absolutePath)
            } catch (e: Exception) {
                part.delete()
                promise.reject("DOWNLOAD_FAILED", e.message ?: "Download failed", e)
            } finally {
                downloading = false
            }
        }.start()
    }

    @ReactMethod
    fun cancelDownload() {
        cancelled = true
    }

    /** Opens the system installer for a previously downloaded APK. */
    @ReactMethod
    fun installApk(path: String, promise: Promise) {
        try {
            val file = File(path)
            if (!file.exists()) {
                promise.reject("NO_FILE", "Downloaded APK not found")
                return
            }
            val uri = FileProvider.getUriForFile(
                reactContext,
                reactContext.packageName + ".updatefileprovider",
                file,
            )
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            promise.reject("INSTALL_FAILED", e.message ?: "Could not open the installer", e)
        }
    }
}
