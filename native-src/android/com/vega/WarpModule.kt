package com.vega

import android.util.Log
import android.content.Context
import android.net.ConnectivityManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.ReactPackage
import com.facebook.react.uimanager.ViewManager
import com.facebook.react.modules.network.OkHttpClientProvider
import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.TimeUnit

private const val TAG = "WarpModule"

class WarpModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), LifecycleEventListener {

    init {
        reactContext.addLifecycleEventListener(this)
    }

    override fun getName(): String = "WarpModule"

    @Volatile
    private var warpProcess: Process? = null

    @Volatile
    private var currentPort: Int? = null

    private fun getBinaryFile(): File {
        val nativeLib = File(reactApplicationContext.applicationInfo.nativeLibraryDir, "libusque.so")
        if (nativeLib.exists()) {
            if (!nativeLib.canExecute()) {
                nativeLib.setExecutable(true, false)
            }
            return nativeLib
        }

        val fallback = File(reactApplicationContext.filesDir, "libusque.so")
        if (!fallback.exists() || fallback.length() == 0L) {
            try {
                val apkPath = reactApplicationContext.applicationInfo.sourceDir
                if (apkPath != null) {
                    val apkFile = File(apkPath)
                    if (apkFile.exists()) {
                        java.util.zip.ZipFile(apkFile).use { zip ->
                            // Try the device's actual ABIs first (in preference order), then fall
                            // back to any bundled variant, since we now ship both arm64-v8a and
                            // armeabi-v7a builds of usque.
                            val candidates = android.os.Build.SUPPORTED_ABIS.toList() +
                                listOf("arm64-v8a", "armeabi-v7a")
                            val entry = candidates
                                .distinct()
                                .firstNotNullOfOrNull { abi -> zip.getEntry("lib/$abi/libusque.so") }
                                ?: zip.getEntry("lib/arm64/libusque.so")
                            if (entry != null) {
                                zip.getInputStream(entry).use { input ->
                                    fallback.outputStream().use { output ->
                                        input.copyTo(output)
                                    }
                                }
                                fallback.setExecutable(true, false)
                                Log.i(TAG, "Extracted libusque.so from APK to ${fallback.absolutePath}")
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to extract libusque.so fallback from APK: ${e.message}")
            }
        }

        if (fallback.exists()) {
            fallback.setExecutable(true, false)
            return fallback
        }

        return nativeLib
    }

    private fun getWarpDir(): File {
        val dir = File(reactApplicationContext.filesDir, "warp")
        if (!dir.exists()) {
            dir.mkdirs()
        }
        return dir
    }

    private fun getConfigFile(): File {
        return File(getWarpDir(), "config.json")
    }

    private fun flushConnections() {
        try {
            OkHttpClientProvider.getOkHttpClient().connectionPool.evictAll()
        } catch (e: Exception) {
            Log.w(TAG, "Failed to evict connection pool: ${e.message}")
        }
    }

    // Android apps generally can't read /etc/resolv.conf, so the bundled
    // libusque.so (built with CGO_ENABLED=0, no cgo resolver available)
    // falls back to Go's hardcoded loopback nameservers and fails DNS
    // lookups entirely (e.g. registering with Cloudflare). We work around
    // this by reading the device's actual configured DNS servers and
    // passing them in via the USQUE_DNS_SERVERS env var, which our
    // patched usque build uses to bypass /etc/resolv.conf altogether.
    // Some devices report a local private-DNS proxy address here instead
    // of a real resolver, so we filter loopback addresses out and always
    // append public fallbacks to guarantee at least one working server.
    private fun getUsqueDnsServersEnv(): String {
        val servers = LinkedHashSet<String>()
        try {
            val cm = reactApplicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            val network = cm?.activeNetwork
            val linkProperties = network?.let { cm.getLinkProperties(it) }
            linkProperties?.dnsServers?.forEach { addr ->
                if (!addr.isLoopbackAddress) {
                    val host = addr.hostAddress
                    if (!host.isNullOrBlank()) {
                        servers.add(if (addr.hostAddress?.contains(':') == true) "[$host]:53" else "$host:53")
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read device DNS servers: ${e.message}")
        }
        // Public fallbacks in case the device reports nothing usable (or a
        // Private DNS / DoT proxy address that isn't a plain port-53 server).
        servers.add("1.1.1.1:53")
        servers.add("8.8.8.8:53")
        return servers.joinToString(",")
    }

    private fun stopInternal() {
        try {
            val proc = warpProcess
            if (proc != null && proc.isAlive) {
                proc.destroy()
                proc.waitFor(2, TimeUnit.SECONDS)
                if (proc.isAlive) {
                    proc.destroyForcibly()
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error stopping WARP process: ${e.message}")
        } finally {
            warpProcess = null
            currentPort = null
            DohOkHttpFactory.instance?.warpProxyPort = null
            flushConnections()
        }
    }

    @ReactMethod
    fun startWarp(promise: Promise) {
        Thread {
            try {
                if (warpProcess?.isAlive == true && currentPort != null) {
                    val result = Arguments.createMap().apply {
                        putBoolean("running", true)
                        putInt("port", currentPort!!)
                    }
                    promise.resolve(result)
                    return@Thread
                }

                val binary = getBinaryFile()
                if (!binary.exists()) {
                    promise.reject("WARP_BINARY_NOT_FOUND", "libusque.so not found at ${binary.absolutePath}")
                    return@Thread
                }

                val configFile = getConfigFile()
                val dnsServersEnv = getUsqueDnsServersEnv()
                if (!configFile.exists() || configFile.length() == 0L) {
                    Log.i(TAG, "Registering Cloudflare WARP account non-interactively (-a)...")
                    // usque's Go DNS resolver can't find a nameserver on Android
                    // (no /etc/resolv.conf), so it can't resolve
                    // api.cloudflareclient.com. Go's http client honors
                    // HTTPS_PROXY, so route registration through a tiny in-app
                    // CONNECT proxy: Android's own resolver does the lookup and
                    // the binary never needs DNS for this step, even if it is
                    // an older build without the USQUE_DNS_SERVERS patch.
                    val regProxy = LocalConnectProxy()
                    regProxy.start()
                    try {
                    val regPb = ProcessBuilder(binary.absolutePath, "-c", configFile.absolutePath, "register", "-a")
                    regPb.directory(getWarpDir())
                    regPb.environment()["USQUE_DNS_SERVERS"] = dnsServersEnv
                    val proxyUrl = "http://127.0.0.1:${regProxy.port}"
                    regPb.environment()["HTTPS_PROXY"] = proxyUrl
                    regPb.environment()["https_proxy"] = proxyUrl
                    regPb.environment()["HTTP_PROXY"] = proxyUrl
                    regPb.environment()["http_proxy"] = proxyUrl
                    regPb.redirectErrorStream(true)
                    val regProc = regPb.start()

                    var regOutput = StringBuilder()
                    val readerThread = Thread {
                        try {
                            regProc.inputStream.bufferedReader().forEachLine { line ->
                                Log.d("WarpRegister", line)
                                regOutput.append(line).append("\n")
                            }
                        } catch (_: Exception) {}
                    }
                    readerThread.start()

                    val finished = regProc.waitFor(20, TimeUnit.SECONDS)
                    if (!finished) {
                        regProc.destroyForcibly()
                        promise.reject("WARP_REGISTRATION_TIMEOUT", "WARP registration timed out after 20s")
                        return@Thread
                    }
                    readerThread.join(1000)

                    val exitCode = regProc.exitValue()
                    if (exitCode != 0 || !configFile.exists() || configFile.length() == 0L) {
                        promise.reject("WARP_REGISTRATION_FAILED", "Failed to register WARP client (exit $exitCode, proxy=127.0.0.1:${regProxy.port}, dns=$dnsServersEnv): $regOutput")
                        return@Thread
                    }
                    Log.i(TAG, "WARP registration completed successfully")
                    } finally {
                        regProxy.shutdown()
                    }
                }

                val port = try {
                    ServerSocket(0).use { it.localPort }
                } catch (e: Exception) {
                    8086
                }

                val pb = ProcessBuilder(
                    binary.absolutePath,
                    "-c", configFile.absolutePath,
                    "http-proxy",
                    "-b", "127.0.0.1",
                    "-p", port.toString()
                )
                pb.directory(getWarpDir())
                pb.environment()["USQUE_DNS_SERVERS"] = dnsServersEnv
                pb.redirectErrorStream(true)
                val proc = pb.start()
                warpProcess = proc
                currentPort = port

                var isListening = false
                val logLines = StringBuilder()
                Thread {
                    try {
                        proc.inputStream.bufferedReader().forEachLine { line ->
                            Log.d("WarpProcess", line)
                            logLines.append(line).append("\n")
                            if (line.contains("listening on", ignoreCase = true) || line.contains("HTTP proxy", ignoreCase = true)) {
                                isListening = true
                            }
                        }
                    } catch (_: Exception) {}
                }.start()

                var waitedMs = 0
                while (waitedMs < 2500 && proc.isAlive && !isListening) {
                    Thread.sleep(100)
                    waitedMs += 100
                }

                if (!proc.isAlive) {
                    warpProcess = null
                    currentPort = null
                    promise.reject("WARP_START_FAILED", "WARP proxy process terminated immediately: $logLines")
                    return@Thread
                }

                DohOkHttpFactory.instance?.warpProxyPort = port
                flushConnections()

                val result = Arguments.createMap().apply {
                    putBoolean("running", true)
                    putInt("port", port)
                }
                promise.resolve(result)
            } catch (e: Exception) {
                stopInternal()
                promise.reject("WARP_ERROR", e.message, e)
            }
        }.start()
    }

    @ReactMethod
    fun stopWarp(promise: Promise) {
        Thread {
            try {
                stopInternal()
                val result = Arguments.createMap().apply {
                    putBoolean("running", false)
                }
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("WARP_ERROR", e.message, e)
            }
        }.start()
    }

    @ReactMethod
    fun getStatus(promise: Promise) {
        val isRunning = warpProcess?.isAlive == true
        val result = Arguments.createMap().apply {
            putBoolean("running", isRunning)
            currentPort?.let { putInt("port", it) }
        }
        promise.resolve(result)
    }

    override fun onHostResume() {}

    override fun onHostPause() {}

    override fun onHostDestroy() {
        stopInternal()
    }

    override fun onCatalystInstanceDestroy() {
        stopInternal()
    }
}

class WarpPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(WarpModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}

// Minimal HTTP CONNECT proxy used only while registering the WARP account.
// Hostnames are resolved with Android's system resolver, so the bundled Go
// binary (which has no working DNS on Android) never has to.
private class LocalConnectProxy : Thread("WarpRegisterProxy") {
    private val server = ServerSocket(0, 20, InetAddress.getByName("127.0.0.1"))
    val port: Int get() = server.localPort

    @Volatile
    private var running = true

    init {
        isDaemon = true
    }

    override fun run() {
        while (running) {
            val client = try {
                server.accept()
            } catch (_: Exception) {
                break
            }
            Thread { handle(client) }.apply { isDaemon = true }.start()
        }
    }

    fun shutdown() {
        running = false
        try {
            server.close()
        } catch (_: Exception) {
        }
    }

    private fun readHead(input: java.io.InputStream): String? {
        val sb = StringBuilder()
        while (sb.length < 8192) {
            val b = input.read()
            if (b < 0) return null
            sb.append(b.toChar())
            if (sb.endsWith("\r\n\r\n")) return sb.toString()
        }
        return null
    }

    private fun handle(client: Socket) {
        var upstream: Socket? = null
        try {
            client.soTimeout = 20000
            val head = readHead(client.getInputStream()) ?: return
            val parts = head.lineSequence().first().split(" ")
            if (parts.size < 2 || !parts[0].equals("CONNECT", ignoreCase = true)) {
                client.getOutputStream().write("HTTP/1.1 405 Method Not Allowed\r\n\r\n".toByteArray())
                return
            }
            val hostPort = parts[1]
            val idx = hostPort.lastIndexOf(':')
            val host = if (idx > 0) hostPort.substring(0, idx).trim('[', ']') else hostPort
            val port = if (idx > 0) hostPort.substring(idx + 1).toIntOrNull() ?: 443 else 443

            var lastErr: Exception? = null
            for (addr in InetAddress.getAllByName(host)) {
                try {
                    val s = Socket()
                    s.connect(InetSocketAddress(addr, port), 10000)
                    upstream = s
                    break
                } catch (e: Exception) {
                    lastErr = e
                }
            }
            val up = upstream
            if (up == null) {
                client.getOutputStream().write("HTTP/1.1 502 Bad Gateway\r\n\r\n".toByteArray())
                Log.w(TAG, "Register proxy could not reach $host:$port: ${lastErr?.message}")
                return
            }
            client.getOutputStream().write("HTTP/1.1 200 Connection Established\r\n\r\n".toByteArray())
            client.getOutputStream().flush()
            client.soTimeout = 0

            val t = Thread {
                try {
                    up.getInputStream().copyTo(client.getOutputStream())
                } catch (_: Exception) {
                } finally {
                    try { client.close() } catch (_: Exception) {}
                    try { up.close() } catch (_: Exception) {}
                }
            }
            t.isDaemon = true
            t.start()
            try {
                client.getInputStream().copyTo(up.getOutputStream())
            } catch (_: Exception) {
            }
        } catch (e: Exception) {
            Log.w(TAG, "Register proxy error: ${e.message}")
        } finally {
            try { client.close() } catch (_: Exception) {}
            try { upstream?.close() } catch (_: Exception) {}
        }
    }
}
