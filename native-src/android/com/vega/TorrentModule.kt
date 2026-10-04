package com.vega

import android.util.Log
import com.facebook.react.bridge.*
import org.libtorrent4j.*
import org.libtorrent4j.alerts.*
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class TorrentModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private const val TAG = "TorrentModule"
        private const val STREAM_STARTUP_BYTES = 8L * 1024L * 1024L
        // prepareVideoFile waits for this much of the file head before resolving,
        // so the player starts with data flowing instead of stalling on piece 2.
        private const val STREAM_WARMUP_BYTES = 2L * 1024L * 1024L
        // Tail of the file (MP4 moov atom / MKV cues) is fetched early, not awaited.
        private const val STREAM_TAIL_BYTES = 2L * 1024L * 1024L
        private const val STREAM_TAIL_MAX_PIECE = 8L * 1024L * 1024L
        private var sessionManager: SessionManager? = null
        private var streamServer: TorrentStreamServer? = null
        private val torrentHandles = mutableMapOf<String, TorrentHandle>()
        private val torrentSavePaths = mutableMapOf<String, String>()
        private val torrentOutputPaths = mutableMapOf<String, String>()
    }

    override fun getName(): String = "TorrentModule"

    private fun ensureSession(): SessionManager {
        sessionManager?.let { if (it.isRunning) return it }

        val sm = SessionManager(false)
        val sp = SettingsPack()
        sp.setEnableDht(true)
        sp.setEnableLsd(true)
        sp.listenInterfaces("0.0.0.0:6881,0.0.0.0:6891")
        sp.setDhtBootstrapNodes("router.bittorrent.com:6881,dht.transmissionbt.com:6881,router.utorrent.com:6881,dht.aelitis.com:6881")
        
        sm.start(SessionParams(sp))
        sessionManager = sm
        Log.d(TAG, "SessionManager started, running=${sm.isRunning}")
        return sm
    }

    private fun ensureServer(): TorrentStreamServer {
        streamServer?.let { return it }
        val server = TorrentStreamServer()
        server.sessionManager = ensureSession()
        server.start()
        streamServer = server
        Log.d(TAG, "Stream server started on port ${server.listeningPort}")
        return server
    }

    @ReactMethod
    fun initEngine(promise: Promise) {
        try {
            val sm = ensureSession()
            val server = ensureServer()
            val result = WritableNativeMap().apply {
                putBoolean("running", sm.isRunning)
                putInt("streamPort", server.listeningPort)
            }
            promise.resolve(result)
        } catch (e: Exception) {
            Log.e(TAG, "initEngine failed", e)
            promise.reject("INIT_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun addTorrent(magnetOrUrl: String, outputFolder: String?, fileName: String?, promise: Promise) {
        addTorrentInternal(magnetOrUrl, outputFolder, fileName, false, promise)
    }

    /**
     * Streaming variant of addTorrent: files go to the app cache dir, and the
     * torrent is taken out of libtorrent's auto-managed queue so it can never
     * sit paused behind other torrents while the player waits on it.
     * Remove it afterwards with deleteTorrent(infoHash, true).
     */
    @ReactMethod
    fun addTorrentForStream(magnetOrUrl: String, promise: Promise) {
        val dir = File(reactApplicationContext.cacheDir, "torrent-stream").absolutePath
        addTorrentInternal(magnetOrUrl, dir, null, true, promise)
    }

    private fun discardTorrent(sm: SessionManager, infoHash: String) {
        try {
            val th = sm.find(Sha1Hash.parseHex(infoHash))
            if (th != null && th.isValid) sm.remove(th)
        } catch (_: Exception) {}
        streamServer?.unregisterTorrent(infoHash)
        torrentHandles.remove(infoHash)
        torrentSavePaths.remove(infoHash)
    }

    private fun addTorrentInternal(
        magnetOrUrl: String,
        outputFolder: String?,
        fileName: String?,
        streaming: Boolean,
        promise: Promise
    ) {
        Thread {
            try {
                val expectedHash = if (magnetOrUrl.startsWith("magnet:")) {
                    Regex("btih:([a-fA-F0-9]{40})", RegexOption.IGNORE_CASE)
                        .find(magnetOrUrl)?.groupValues?.get(1)?.lowercase()
                } else null

                val sm = ensureSession()
                val server = ensureServer()
                val downloadDir = outputFolder
                    ?: (reactApplicationContext.filesDir.absolutePath + "/torrents")
                File(downloadDir).mkdirs()

                // Check both our Map and the actual C++ session manager
                var existing = if (expectedHash != null) torrentHandles[expectedHash] else null
                if (existing == null && expectedHash != null) {
                    existing = sm.find(Sha1Hash.parseHex(expectedHash))
                    if (existing != null && existing.isValid) {
                        torrentHandles[expectedHash] = existing
                        torrentSavePaths[expectedHash] = downloadDir
                    }
                }

                if (existing != null && existing.isValid) {
                    try {
                        if (existing.status().hasMetadata()) {
                            // The torrent may have been added elsewhere (e.g. a download)
                            // with a different save dir -- the server must read from there.
                            val realDir = torrentSavePaths[expectedHash!!] ?: downloadDir
                            server.registerTorrent(expectedHash, File(realDir))
                            val info = buildTorrentInfo(existing)
                            if (streaming && realDir != downloadDir) info.putBoolean("foreign", true)
                            promise.resolve(info)
                            return@Thread
                        }
                    } catch (e: Exception) {
                        torrentHandles.remove(expectedHash!!)
                        torrentSavePaths.remove(expectedHash)
                    }
                }

                var addError: String? = null
                val metadataLatch = CountDownLatch(1)

                val listener = object : AlertListener {
                    override fun types(): IntArray? = null
                    override fun alert(alert: Alert<*>) {
                        when (alert) {
                            is AddTorrentAlert -> {
                                if (alert.error().isError) {
                                    addError = alert.error().toString()
                                    metadataLatch.countDown()
                                    return
                                }
                                val th = alert.handle()
                                val alertHash = try { th.infoHash().toHex() } catch(_: Exception) { return }
                                if (expectedHash != null && alertHash != expectedHash) return
                                Log.d(TAG, "Alert: AddTorrentAlert for $alertHash")

                                try {
                                    torrentHandles[alertHash] = th
                                    torrentSavePaths[alertHash] = downloadDir
                                    if (streaming) {
                                        // download(magnet, dir, flags) ORs flags into the defaults, so
                                        // AUTO_MANAGED can only be cleared on the handle. A queue-paused
                                        // torrent stays paused after that, hence resume().
                                        th.unsetFlags(TorrentFlags.AUTO_MANAGED)
                                        th.resume()
                                    }
                                    if (th.status().hasMetadata()) {
                                        metadataLatch.countDown()
                                    }
                                } catch(_: Exception) {}
                            }
                            is MetadataReceivedAlert -> {
                                val alertHash = try { alert.handle().infoHash().toHex() } catch(_: Exception) { return }
                                if (expectedHash != null && alertHash != expectedHash) return
                                Log.d(TAG, "Alert: MetadataReceivedAlert for $alertHash")
                                metadataLatch.countDown()
                            }
                            is MetadataFailedAlert -> {
                                val alertHash = try { alert.handle().infoHash().toHex() } catch(_: Exception) { return }
                                if (expectedHash != null && alertHash != expectedHash) return
                                Log.d(TAG, "Alert: MetadataFailedAlert for $alertHash")
                                addError = "Failed to fetch magnet metadata"
                                metadataLatch.countDown()
                            }
                            is TorrentErrorAlert -> {
                                val alertHash = try { alert.handle().infoHash().toHex() } catch(_: Exception) { return }
                                if (expectedHash != null && alertHash == expectedHash) {
                                    Log.e(TAG, "Alert: TorrentErrorAlert for $alertHash - ${alert.error().message}")
                                }
                            }
                            is TorrentRemovedAlert -> {
                                val alertHash = try { alert.handle().infoHash().toHex() } catch(_: Exception) { return }
                                if (expectedHash != null && alertHash == expectedHash) {
                                    Log.d(TAG, "Alert: TorrentRemovedAlert for $alertHash")
                                }
                            }
                        }
                    }
                }

                sm.addListener(listener)

                Log.d(TAG, "Starting download: $magnetOrUrl -> $downloadDir")
                if (magnetOrUrl.startsWith("magnet:") ||
                    magnetOrUrl.startsWith("http://") ||
                    magnetOrUrl.startsWith("https://")) {
                    sm.download(magnetOrUrl, File(downloadDir), TorrentFlags.AUTO_MANAGED)
                } else {
                    val ti = TorrentInfo(File(magnetOrUrl))
                    sm.download(ti, File(downloadDir))
                }

                Log.d(TAG, "Waiting for metadata (45s timeout)...")
                val gotMetadata = metadataLatch.await(45, TimeUnit.SECONDS)
                Log.d(TAG, "Metadata wait done: gotMetadata=$gotMetadata, addError=$addError")
                sm.removeListener(listener)

                if (addError != null) {
                    if (streaming && expectedHash != null) discardTorrent(sm, expectedHash)
                    promise.reject("ADD_ERROR", addError)
                    return@Thread
                }

                if (!gotMetadata) {
                    if (streaming && expectedHash != null) discardTorrent(sm, expectedHash)
                    promise.reject("TIMEOUT", "Timed out waiting for torrent metadata")
                    return@Thread
                }

                val finalHashHex = expectedHash ?: return@Thread promise.reject("INVALID_HANDLE", "Could not determine infoHash")
                
                val th = sm.find(Sha1Hash.parseHex(finalHashHex))
                Log.d(TAG, "Found handle for $finalHashHex: valid=${th?.isValid}, hasMetadata=${try { th?.status()?.hasMetadata() } catch(_:Exception) { "error" }}")
                if (th == null || !th.isValid) {
                    promise.reject("INVALID_HANDLE", "Torrent handle became invalid after addition")
                    return@Thread
                }
                
                try {
                    torrentHandles[finalHashHex] = th
                    torrentSavePaths[finalHashHex] = downloadDir
                    if (th.status().hasMetadata()) {
                        if (fileName != null) {
                            try {
                                val ti = th.torrentFile()
                                if (ti != null) {
                                    var maxIdx = 0
                                    var maxSize = 0L
                                    val fs = ti.files()
                                    for (i in 0 until fs.numFiles()) {
                                        val size = fs.fileSize(i)
                                        if (size > maxSize) {
                                            maxSize = size
                                            maxIdx = i
                                        }
                                    }
                                    if (maxSize > 0) {
                                        val originalPath = fs.filePath(maxIdx)
                                        val ext = File(originalPath).extension
                                        val newName = if (ext.isNotEmpty()) "$fileName.$ext" else fileName
                                        th.renameFile(maxIdx, newName)
                                        torrentOutputPaths[finalHashHex] = File(downloadDir, newName).absolutePath
                                        Log.d(TAG, "Renamed torrent file $originalPath to $newName")
                                    }
                                }
                            } catch (e: Exception) {
                                Log.e(TAG, "Failed to rename torrent file", e)
                            }
                        }
                        
                        server.registerTorrent(finalHashHex, File(downloadDir))
                        Log.d(TAG, "Registered torrent with stream server: $finalHashHex")
                    }
                    promise.resolve(buildTorrentInfo(th))
                } catch(e: Exception) {
                    promise.reject("INVALID_HANDLE", "Torrent handle error: ${e.message}")
                }

            } catch (e: Exception) {
                Log.e(TAG, "addTorrent failed", e)
                promise.reject("ADD_ERROR", e.message, e)
            }
        }.start()
    }

    @ReactMethod
    fun getStats(infoHash: String, promise: Promise) {
        try {
            val th = try { ensureSession().find(Sha1Hash.parseHex(infoHash)) } catch(e: Exception) { null }
            if (th == null || !th.isValid) {
                promise.reject("NOT_FOUND", "Torrent handle not found or invalid")
                return
            }
            
            val status = try { th.status() } catch(e: Exception) {
                promise.reject("INVALID_HANDLE", "Torrent handle is no longer valid")
                return
            }
            
            val result = WritableNativeMap().apply {
                putString("state", mapState(status.state()))
                putDouble("progress", status.progress().toDouble())
                putDouble("downloadRate", status.downloadRate().toDouble())
                putDouble("uploadRate", status.uploadRate().toDouble())
                putInt("numPeers", status.numPeers())
                putInt("numSeeds", status.numSeeds())
                putDouble("totalDone", status.totalDone().toDouble())
                putDouble("totalWanted", status.totalWanted().toDouble())
                putBoolean("hasMetadata", status.hasMetadata())
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("STATS_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun getStreamUrl(infoHash: String, fileIndex: Int, promise: Promise) {
        try {
            val server = ensureServer()
            var filename = "video.mp4"
            val th = try { ensureSession().find(Sha1Hash.parseHex(infoHash)) } catch(e: Exception) { null }
            if (th != null && th.isValid) {
                try {
                    val ti = th.torrentFile()
                    filename = ti.files().fileName(fileIndex)
                } catch(e: Exception) {}
            }
            val encodedFilename = java.net.URLEncoder.encode(filename, "UTF-8").replace("+", "%20")
            val url = "http://127.0.0.1:${server.listeningPort}/stream/$infoHash/$fileIndex/$encodedFilename"
            promise.resolve(url)
        } catch (e: Exception) {
            promise.reject("STREAM_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun prepareVideoFile(infoHash: String, fileIndex: Int, promise: Promise) {
        Thread {
            try {
                Log.d(TAG, "prepareVideoFile: infoHash=$infoHash, fileIndex=$fileIndex")
                val sm = ensureSession()
                val th = sm.find(Sha1Hash.parseHex(infoHash))
                if (th == null || !th.isValid) {
                    promise.reject("NOT_FOUND", "Torrent handle not found or invalid")
                    return@Thread
                }
                
                if (!th.status().hasMetadata()) {
                    promise.reject("NO_METADATA", "No metadata yet")
                    return@Thread
                }
                
                val ti = try { th.torrentFile() } catch(e: Exception) { null }
                if (ti == null) {
                    promise.reject("INVALID_HANDLE", "Torrent handle invalid")
                    return@Thread
                }
                
                val fs = ti.files()
                if (fileIndex >= fs.numFiles() || fileIndex < 0) {
                    promise.reject("INVALID_INDEX", "File index out of bounds")
                    return@Thread
                }
                
                val fileOffset = fs.fileOffset(fileIndex)
                val fileSize = fs.fileSize(fileIndex)
                val pieceLength = ti.pieceLength().toLong()
                val startPiece = (fileOffset / pieceLength).toInt()
                val startupEndOffset = fileOffset + minOf(fileSize, STREAM_STARTUP_BYTES) - 1L
                val startupEndPiece = (startupEndOffset / pieceLength).toInt()
                val warmEndOffset = fileOffset + minOf(fileSize, STREAM_WARMUP_BYTES) - 1L
                val warmEndPiece = (warmEndOffset / pieceLength).toInt()

                th.unsetFlags(TorrentFlags.SEQUENTIAL_DOWNLOAD)
                val filePriorities = Priority.array(Priority.IGNORE, fs.numFiles())
                filePriorities[fileIndex] = Priority.TOP_PRIORITY
                th.prioritizeFiles(filePriorities)

                for (pieceIndex in startPiece..startupEndPiece) {
                    if (!th.havePiece(pieceIndex)) {
                        th.piecePriority(pieceIndex, Priority.TOP_PRIORITY)
                        th.setPieceDeadline(pieceIndex, 1000 + (pieceIndex - startPiece) * 250)
                    }
                }

                // Tail of the file: MP4 moov / MKV cues are needed for the first seek
                // (and for moov-at-end MP4s, to start at all). Queue it behind the
                // head via later deadlines, but don't block on it. Skipped for huge
                // pieces where the tail would cost tens of MB.
                if (fileSize > STREAM_STARTUP_BYTES * 2 && pieceLength <= STREAM_TAIL_MAX_PIECE) {
                    val tailStartOffset = fileOffset + fileSize - minOf(fileSize, STREAM_TAIL_BYTES)
                    val tailStartPiece = (tailStartOffset / pieceLength).toInt()
                    val tailEndPiece = ((fileOffset + fileSize - 1L) / pieceLength).toInt()
                    for (pieceIndex in tailStartPiece..tailEndPiece) {
                        if (pieceIndex > startupEndPiece && !th.havePiece(pieceIndex)) {
                            th.piecePriority(pieceIndex, Priority.SIX)
                            th.setPieceDeadline(pieceIndex, 8000 + (pieceIndex - tailStartPiece) * 250)
                        }
                    }
                }

                Log.d(
                    TAG,
                    "prepareVideoFile: file=$fileIndex, pieces=$startPiece-$startupEndPiece, warmup=$startPiece-$warmEndPiece, startupBytes=${minOf(fileSize, STREAM_STARTUP_BYTES)}"
                )

                var waitCount = 0
                while (th.isValid && waitCount < 3000) {
                    var warm = true
                    for (pieceIndex in startPiece..warmEndPiece) {
                        if (!th.havePiece(pieceIndex)) { warm = false; break }
                    }
                    if (warm) {
                        promise.resolve(true)
                        return@Thread
                    }
                    Thread.sleep(100)
                    waitCount++
                }

                if (!th.isValid) {
                    promise.reject("INVALID_HANDLE", "Torrent handle became invalid while preparing video")
                } else {
                    promise.reject("TIMEOUT", "Timed out waiting for the first video piece")
                }
            } catch (e: Exception) {
                promise.reject("PREPARE_ERROR", e.message, e)
            }
        }.start()
    }

    @ReactMethod
    fun getFiles(infoHash: String, promise: Promise) {
        try {
            val th = try { ensureSession().find(Sha1Hash.parseHex(infoHash)) } catch(e: Exception) { null }
            if (th == null || !th.isValid) {
                promise.reject("NOT_FOUND", "Torrent handle not found or invalid")
                return
            }

            val status = try { th.status() } catch(e: Exception) {
                promise.reject("INVALID_HANDLE", "Torrent handle is no longer valid")
                return
            }

            if (!status.hasMetadata()) {
                promise.reject("NO_METADATA", "Torrent metadata not available")
                return
            }

            val ti = try { th.torrentFile() } catch(e: Exception) { null }
            if (ti == null) {
                promise.reject("INVALID_HANDLE", "Torrent handle invalid")
                return
            }
            val files = WritableNativeArray()
            val fs = ti.files()
            for (i in 0 until fs.numFiles()) {
                val file = WritableNativeMap().apply {
                    putInt("index", i)
                    putString("name", fs.fileName(i))
                    putString("path", fs.filePath(i))
                    putDouble("size", fs.fileSize(i).toDouble())
                }
                files.pushMap(file)
            }
            promise.resolve(files)
        } catch (e: Exception) {
            promise.reject("FILES_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun pauseTorrent(infoHash: String, promise: Promise) {
        try {
            val th = try { ensureSession().find(Sha1Hash.parseHex(infoHash)) } catch(e: Exception) { null }
            th?.pause()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("PAUSE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun resumeTorrent(infoHash: String, promise: Promise) {
        try {
            val th = try { ensureSession().find(Sha1Hash.parseHex(infoHash)) } catch(e: Exception) { null }
            th?.resume()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("RESUME_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun completeTorrent(infoHash: String, promise: Promise) {
        try {
            val outputPath = torrentOutputPaths[infoHash]
            if (outputPath == null) {
                promise.reject("OUTPUT_NOT_FOUND", "Torrent output path is unavailable")
                return
            }
            val outputFile = File(outputPath)
            if (!outputFile.exists() || outputFile.length() <= 0L) {
                promise.reject("OUTPUT_NOT_FOUND", "Torrent output file is missing")
                return
            }
            val result = WritableNativeMap().apply {
                putBoolean("success", true)
                putString("outputPath", outputFile.absolutePath)
                putString("fileName", outputFile.name)
                putDouble("size", outputFile.length().toDouble())
            }
            promise.resolve(result)
        } catch (e: Exception) {
            promise.reject("COMPLETE_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun deleteTorrent(infoHash: String, deleteFiles: Boolean, promise: Promise) {
        Log.e(TAG, "deleteTorrent called for infoHash: $infoHash, deleteFiles: $deleteFiles")
        try {
            val sm = ensureSession()
            val th = try { sm.find(Sha1Hash.parseHex(infoHash)) } catch(e: Exception) { null }
            
            val pathsToDelete = mutableListOf<String>()
            val savePath = torrentSavePaths[infoHash]
            torrentOutputPaths[infoHash]?.let { pathsToDelete.add(it) }
            if (deleteFiles && th != null && savePath != null) {
                try {
                    val ti = th.torrentFile()
                    if (ti != null) {
                        val fs = ti.files()
                        for (i in 0 until fs.numFiles()) {
                            // If we renamed the file, we can't easily query th for the new name without extra bindings.
                            // But libtorrent's session remove(th) might not delete files.
                            // We will delete the original file paths.
                            pathsToDelete.add(File(savePath, fs.filePath(i)).absolutePath)
                        }
                    }
                } catch (_: Exception) {}
            }
            
            if (th != null && sm != null) {
                try { th.pause() } catch (_: Exception) {}
                try { sm.remove(th) } catch (_: Exception) {}
            }
            
            streamServer?.unregisterTorrent(infoHash)
            torrentHandles.remove(infoHash)
            torrentSavePaths.remove(infoHash)
            torrentOutputPaths.remove(infoHash)

            for (path in pathsToDelete) {
                try { 
                    val f = File(path)
                    f.delete()
                    // Delete parent dir if it's empty and not the root savePath
                    val parent = f.parentFile
                    if (parent != null && parent.absolutePath != savePath && parent.list()?.isEmpty() == true) {
                        parent.delete()
                    }
                } catch (_: Exception) {}
            }

            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("DELETE_ERROR", e.message, e)
        }
    }

    private fun buildTorrentInfo(th: TorrentHandle): WritableMap {
        val hasMeta = try { th.status().hasMetadata() } catch(e: Exception) { false }
        val infoHash = try { th.infoHash().toHex() } catch(e: Exception) { "" }
        
        val result = WritableNativeMap().apply {
            putString("infoHash", infoHash)
            putBoolean("hasMetadata", hasMeta)
        }

        if (hasMeta) {
            try {
                val ti = th.torrentFile()
                if (ti != null) {
                    result.putString("name", ti.name())
                    result.putDouble("totalSize", ti.totalSize().toDouble())
        
                    val files = WritableNativeArray()
                    val fs = ti.files()
                    for (i in 0 until fs.numFiles()) {
                        val file = WritableNativeMap().apply {
                            putInt("index", i)
                            putString("name", fs.fileName(i))
                            putString("path", fs.filePath(i))
                            putDouble("size", fs.fileSize(i).toDouble())
                        }
                        files.pushMap(file)
                    }
                    result.putArray("files", files)
                }
            } catch(e: Exception) {}
        }
        return result
    }

    private fun mapState(state: TorrentStatus.State): String {
        return when (state) {
            TorrentStatus.State.CHECKING_FILES -> "checking"
            TorrentStatus.State.DOWNLOADING_METADATA -> "metadata"
            TorrentStatus.State.DOWNLOADING -> "downloading"
            TorrentStatus.State.FINISHED -> "finished"
            TorrentStatus.State.SEEDING -> "seeding"
            TorrentStatus.State.CHECKING_RESUME_DATA -> "checking"
            else -> "unknown"
        }
    }
}
