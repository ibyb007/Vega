package com.vega

import android.util.Log
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.ReactCookieJarContainer
import okhttp3.Cache
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.dnsoverhttps.DnsOverHttps
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

private const val TAG = "DohOkHttpFactory"

enum class DohProvider(val displayName: String, val url: String, val bootstrapIps: List<String>) {
    CLOUDFLARE("Cloudflare", "https://1.1.1.1/dns-query", listOf("1.1.1.1", "1.0.0.1")),
    GOOGLE("Google", "https://dns.google/dns-query", listOf("8.8.8.8", "8.8.4.4")),
    ADGUARD("AdGuard", "https://dns.adguard-dns.com/dns-query", listOf("94.140.14.14", "94.140.15.15")),
}

class DohOkHttpFactory(private val cacheDir: File) : OkHttpClientFactory {

    companion object {
        @Volatile
        var instance: DohOkHttpFactory? = null
            private set
    }

    init {
        instance = this
    }

    @Volatile
    var enabled: Boolean = true

    @Volatile
    var currentProvider: DohProvider = DohProvider.CLOUDFLARE

    @Volatile
    var customUrl: String? = null

    // Local port of the Cloudflare WARP HTTP proxy (see WarpModule), or null
    // when WARP isn't running. Set/cleared by WarpModule as it starts/stops
    // the tunnel; read here on every request via the ProxySelector below.
    @Volatile
    var warpProxyPort: Int? = null

    private var cachedDoh: DnsOverHttps? = null
    private var lastConfigKey: String = ""

    @Synchronized
    private fun getActiveDns(): Dns {
        if (!enabled) return Dns.SYSTEM

        val configKey = "${currentProvider.name}_$customUrl"
        if (cachedDoh != null && lastConfigKey == configKey) {
            return FallbackDns(cachedDoh!!)
        }

        return try {
            val dnsCache = Cache(File(cacheDir, "dns_cache"), 5L * 1024 * 1024)
            val bootstrapClient = OkHttpClient.Builder()
                .cache(dnsCache)
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(10, TimeUnit.SECONDS)
                .build()

            val url = customUrl?.takeIf { it.isNotBlank() } ?: currentProvider.url

            val builder = DnsOverHttps.Builder()
                .client(bootstrapClient)
                .url(url.toHttpUrl())

            if (customUrl == null || customUrl!!.isBlank()) {
                val ips = currentProvider.bootstrapIps.map { InetAddress.getByName(it) }
                builder.bootstrapDnsHosts(ips)
            }

            val doh = builder.build()
            Log.i(TAG, "DoH configured with ${customUrl ?: currentProvider.displayName}")
            
            cachedDoh = doh
            lastConfigKey = configKey
            FallbackDns(doh)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to build DoH, falling back to system DNS", e)
            Dns.SYSTEM
        }
    }

    private inner class DynamicDns : Dns {
        override fun lookup(hostname: String): List<InetAddress> {
            return getActiveDns().lookup(hostname)
        }
    }

    override fun createNewNetworkModuleClient(): OkHttpClient {
        return OkHttpClient.Builder()
            .dns(DynamicDns())
            .cookieJar(ReactCookieJarContainer())
            .proxySelector(object : ProxySelector() {
                override fun select(uri: URI?): List<Proxy> {
                    val host = uri?.host?.lowercase()
                    if (host != null && (host == "127.0.0.1" || host == "localhost")) {
                        return listOf(Proxy.NO_PROXY)
                    }
                    val warpPort = warpProxyPort
                    if (warpPort != null && warpPort > 0) {
                        Log.d(TAG, "Routing ${uri?.host} through WARP HTTP proxy on port $warpPort")
                        return listOf(Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", warpPort)))
                    }
                    return listOf(Proxy.NO_PROXY)
                }

                override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: IOException?) {
                    Log.w(TAG, "Proxy connection failed for $uri: ${ioe?.message}")
                }
            })
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }
}

private class FallbackDns(private val primary: DnsOverHttps) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        return try {
            primary.lookup(hostname)
        } catch (e: UnknownHostException) {
            Log.w(TAG, "DoH lookup failed for $hostname, falling back to system DNS")
            Dns.SYSTEM.lookup(hostname)
        } catch (e: Exception) {
            Log.w(TAG, "DoH error for $hostname, falling back to system DNS", e)
            Dns.SYSTEM.lookup(hostname)
        }
    }
}
