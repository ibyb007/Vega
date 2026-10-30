package com.vega

import android.app.Activity
import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import java.net.HttpURLConnection
import java.net.URL

private const val TAG = "PlaybackSession"

/**
 * Publishes the player's state as a system MediaSession so remote controllers
 * (atvTools, Google TV / Android TV remote apps, Bluetooth remotes, `adb shell
 * input keyevent`, Home Assistant, ...) can show "Now playing" and drive it,
 * the same way SmartTube / Stremio / YouTube do.
 *
 *   JS -> native: start, update, stop
 *   native -> JS: PlaybackSession:onCommand {action, positionMs}
 *                 PlaybackSession:onActivityStopped
 *
 * Uses the framework android.media.session.MediaSession, so it needs no extra
 * dependency, no foreground service and no notification.
 */
class PlaybackSessionModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), LifecycleEventListener {

    private val mainHandler = Handler(Looper.getMainLooper())

    private var session: MediaSession? = null
    private var title: String = ""
    private var subtitle: String = ""
    private var artworkUrl: String? = null
    private var artwork: Bitmap? = null
    private var durationMs: Long = 0L
    private var artGeneration = 0

    private val callback = object : MediaSession.Callback() {
        override fun onPlay() = emitCommand("play")
        override fun onPause() = emitCommand("pause")
        override fun onStop() = emitCommand("pause")
        override fun onSeekTo(pos: Long) = emitCommand("seekTo", pos)
        override fun onFastForward() = emitCommand("fastForward")
        override fun onRewind() = emitCommand("rewind")
        override fun onSkipToNext() = emitCommand("next")
        override fun onSkipToPrevious() = emitCommand("previous")
    }

    // Fires when the activity is no longer visible at all (Home pressed,
    // another app launched, screen off). A Quick Settings style overlay only
    // pauses the activity and never reaches onStop, so it doesn't trigger this.
    private val lifecycleCallbacks = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityStopped(activity: Activity) {
            if (activity.isChangingConfigurations) return
            if (activity !== reactApplicationContext.currentActivity) return
            emit("PlaybackSession:onActivityStopped", null)
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
        override fun onActivityStarted(activity: Activity) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}
    }

    init {
        reactContext.addLifecycleEventListener(this)
        (reactContext.applicationContext as? Application)
            ?.registerActivityLifecycleCallbacks(lifecycleCallbacks)
    }

    override fun getName(): String = "PlaybackSessionModule"

    private fun emit(event: String, params: WritableMap?) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(event, params)
        } catch (e: Exception) {
            // Context torn down mid-transition -- safe to drop.
        }
    }

    private fun emitCommand(action: String, positionMs: Long = 0L) {
        emit(
            "PlaybackSession:onCommand",
            Arguments.createMap().apply {
                putString("action", action)
                putDouble("positionMs", positionMs.toDouble())
            },
        )
    }

    private fun ensureSession(): MediaSession {
        session?.let { return it }
        val s = MediaSession(reactApplicationContext, "VegaTV")
        @Suppress("DEPRECATION")
        s.setFlags(
            MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS,
        )
        s.setCallback(callback, mainHandler)
        session = s
        return s
    }

    private fun pushMetadata() {
        val s = session ?: return
        val b = MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, subtitle)
        if (durationMs > 0) b.putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs)
        val url = artworkUrl
        if (!url.isNullOrBlank()) {
            b.putString(MediaMetadata.METADATA_KEY_ART_URI, url)
            b.putString(MediaMetadata.METADATA_KEY_ALBUM_ART_URI, url)
            b.putString(MediaMetadata.METADATA_KEY_DISPLAY_ICON_URI, url)
        }
        artwork?.let {
            b.putBitmap(MediaMetadata.METADATA_KEY_ART, it)
            b.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it)
            b.putBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON, it)
        }
        s.setMetadata(b.build())
    }

    private fun pushState(state: String, positionMs: Long, hasNext: Boolean, hasPrevious: Boolean) {
        val s = session ?: return
        var actions = PlaybackState.ACTION_PLAY or
            PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_STOP or
            PlaybackState.ACTION_SEEK_TO or
            PlaybackState.ACTION_FAST_FORWARD or
            PlaybackState.ACTION_REWIND
        if (hasNext) actions = actions or PlaybackState.ACTION_SKIP_TO_NEXT
        if (hasPrevious) actions = actions or PlaybackState.ACTION_SKIP_TO_PREVIOUS

        val st = when (state) {
            "playing" -> PlaybackState.STATE_PLAYING
            "buffering" -> PlaybackState.STATE_BUFFERING
            else -> PlaybackState.STATE_PAUSED
        }
        val speed = if (st == PlaybackState.STATE_PLAYING) 1f else 0f
        s.setPlaybackState(
            PlaybackState.Builder()
                .setActions(actions)
                .setState(st, positionMs.coerceAtLeast(0L), speed, SystemClock.elapsedRealtime())
                .build(),
        )
    }

    private fun loadArtwork(url: String?, generation: Int) {
        if (url.isNullOrBlank() || !url.startsWith("http")) return
        Thread {
            var conn: HttpURLConnection? = null
            try {
                conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 8000
                    readTimeout = 8000
                    instanceFollowRedirects = true
                    setRequestProperty("User-Agent", "Mozilla/5.0")
                }
                if (conn.contentLength > 10 * 1024 * 1024) return@Thread
                val bytes = conn.inputStream.use { it.readBytes() }
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1
                while (bounds.outWidth / sample > 1024 || bounds.outHeight / sample > 1024) sample *= 2
                val bmp = BitmapFactory.decodeByteArray(
                    bytes, 0, bytes.size,
                    BitmapFactory.Options().apply { inSampleSize = sample },
                )
                if (bmp != null) {
                    mainHandler.post {
                        if (generation == artGeneration && session != null) {
                            artwork = bmp
                            pushMetadata()
                        }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Artwork load failed: ${e.message}")
            } finally {
                conn?.disconnect()
            }
        }.apply { isDaemon = true }.start()
    }

    /** Called when a new video starts (or the episode changes). */
    @ReactMethod
    fun start(
        title: String,
        subtitle: String?,
        artworkUrl: String?,
        durationMs: Double,
        hasNext: Boolean,
        hasPrevious: Boolean,
    ) {
        UiThreadUtil.runOnUiThread {
            try {
                val s = ensureSession()
                this.title = title
                this.subtitle = subtitle ?: ""
                if (this.artworkUrl != artworkUrl) {
                    this.artwork = null
                    this.artworkUrl = artworkUrl
                }
                this.durationMs = durationMs.toLong()
                artGeneration++
                pushMetadata()
                pushState("buffering", 0L, hasNext, hasPrevious)
                s.isActive = true
                if (this.artwork == null) loadArtwork(artworkUrl, artGeneration)
            } catch (e: Exception) {
                Log.w(TAG, "start failed: ${e.message}")
            }
        }
    }

    /** state: "playing" | "paused" | "buffering". */
    @ReactMethod
    fun update(
        state: String,
        positionMs: Double,
        durationMs: Double,
        hasNext: Boolean,
        hasPrevious: Boolean,
    ) {
        UiThreadUtil.runOnUiThread {
            try {
                if (session == null) return@runOnUiThread
                val newDuration = durationMs.toLong()
                if (newDuration > 0 && newDuration != this.durationMs) {
                    this.durationMs = newDuration
                    pushMetadata()
                }
                pushState(state, positionMs.toLong(), hasNext, hasPrevious)
            } catch (e: Exception) {
                Log.w(TAG, "update failed: ${e.message}")
            }
        }
    }

    @ReactMethod
    fun stop() {
        UiThreadUtil.runOnUiThread { release() }
    }

    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    private fun release() {
        artGeneration++
        artwork = null
        artworkUrl = null
        try {
            session?.isActive = false
            session?.release()
        } catch (_: Exception) {
        }
        session = null
    }

    override fun onHostResume() {}

    override fun onHostPause() {}

    override fun onHostDestroy() {
        mainHandler.post { release() }
    }

    override fun invalidate() {
        (reactApplicationContext.applicationContext as? Application)
            ?.unregisterActivityLifecycleCallbacks(lifecycleCallbacks)
        mainHandler.post { release() }
        super.invalidate()
    }
}

class PlaybackSessionPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(PlaybackSessionModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
