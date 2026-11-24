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
import java.io.RandomAccessFile
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

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
        // Release APKs are tens of MB: split them over parallel connections.
        private const val PARALLEL_PARTS = 6
        private const val MIN_PART_BYTES = 1L * 1024 * 1024
        private const val PART_RETRIES = 3
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

    /**
     * Downloads [url] to cache/updates/[fileName]; resolves with the file path.
     * Uses several parallel Range requests when the server supports them
     * (GitHub's release CDN does) and falls back to one stream otherwise.
     */
    @ReactMethod
    fun downloadApk(url: String, fileName: String, promise: Promise) {
        if (downloading) {
            promise.reject("BUSY", "A download is already running")
            return
        }
        downloading = true
        cancelled = false
        Thread {
            val safeName = File(fileName).name
            val dir = updateDir()
            // Drop older downloaded APKs so the cache never accumulates.
            dir.listFiles()?.forEach { if (it.name != safeName) it.delete() }
            val target = File(dir, safeName)
            val part = File(dir, "$safeName.part")
            try {
                if (part.exists()) part.delete()
                val probe = probeRanges(url)
                if (probe != null && probe.second >= MIN_PART_BYTES * 2) {
                    downloadParallel(probe.first, probe.second, part)
                } else {
                    downloadSingle(url, part)
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

    /**
     * Asks for the first byte only. Returns (final URL after redirects, total
     * size) when the server answers 206 with a Content-Range, else null.
     */
    private fun probeRanges(url: String): Pair<String, Long>? {
        return try {
            val request = Request.Builder()
                .url(url)
                .header("Range", "bytes=0-0")
                .header("Accept", "application/octet-stream")
                .build()
            client.newCall(request).execute().use { response ->
                if (response.code != 206) return null
                val range = response.header("Content-Range") ?: return null
                val total = range.substringAfter('/', "").trim().toLongOrNull() ?: return null
                if (total <= 0) return null
                Pair(response.request.url.toString(), total)
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun downloadSingle(url: String, part: File) {
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
            if (total > 0 && received != total) throw RuntimeException("Download incomplete")
            emitProgress(received, total)
        }
    }

    private fun downloadParallel(url: String, total: Long, part: File) {
        RandomAccessFile(part, "rw").use { it.setLength(total) }

        val partCount = minOf(PARALLEL_PARTS.toLong(), maxOf(1L, total / MIN_PART_BYTES)).toInt()
        val chunk = total / partCount
        val received = AtomicLong(0)
        val lastEmit = AtomicLong(0)
        val progress = {
            val now = System.currentTimeMillis()
            val last = lastEmit.get()
            if (now - last > 250 && lastEmit.compareAndSet(last, now)) {
                emitProgress(received.get(), total)
            }
        }

        val pool = Executors.newFixedThreadPool(partCount)
        try {
            val futures = ArrayList<Future<*>>()
            for (i in 0 until partCount) {
                val start = i * chunk
                val end = if (i == partCount - 1) total - 1 else start + chunk - 1
                futures.add(pool.submit {
                    var offset = start
                    var attempt = 0
                    while (offset <= end) {
                        if (cancelled) throw RuntimeException("Download cancelled")
                        try {
                            val request = Request.Builder()
                                .url(url)
                                .header("Range", "bytes=$offset-$end")
                                .header("Accept", "application/octet-stream")
                                .build()
                            client.newCall(request).execute().use { response ->
                                if (response.code != 206) {
                                    throw RuntimeException("Server returned HTTP " + response.code)
                                }
                                val body = response.body ?: throw RuntimeException("Empty response")
                                RandomAccessFile(part, "rw").use { out ->
                                    out.seek(offset)
                                    val buffer = ByteArray(64 * 1024)
                                    body.byteStream().use { input ->
                                        while (offset <= end) {
                                            if (cancelled) throw RuntimeException("Download cancelled")
                                            val want = minOf(buffer.size.toLong(), end - offset + 1).toInt()
                                            val read = input.read(buffer, 0, want)
                                            if (read < 0) break
                                            out.write(buffer, 0, read)
                                            offset += read
                                            received.addAndGet(read.toLong())
                                            progress()
                                        }
                                    }
                                }
                            }
                            if (offset <= end) throw RuntimeException("Connection closed early")
                        } catch (e: Exception) {
                            if (cancelled) throw e
                            // Resume this part from where it stopped.
                            if (++attempt > PART_RETRIES) throw e
                            Thread.sleep(500L * attempt)
                        }
                    }
                })
            }
            for (f in futures) {
                try {
                    f.get()
                } catch (e: java.util.concurrent.ExecutionException) {
                    // One part gave up: stop the rest and surface its error.
                    cancelled = true
                    throw RuntimeException(e.cause?.message ?: "Download failed")
                }
            }
        } finally {
            pool.shutdownNow()
        }
        if (received.get() != total) throw RuntimeException("Download incomplete")
        emitProgress(total, total)
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
