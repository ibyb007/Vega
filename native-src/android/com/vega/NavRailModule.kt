package com.vega

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.ViewManager

/**
 * Thin JS <-> native seam for the rail. This is intentionally the *only*
 * traffic that crosses the bridge for navigation chrome now:
 *   JS -> native: setActiveRoute, focusRoute, setVisible, registerRouteHandle
 *   native -> JS: onRouteChanged, onRouteReselected, onExpandedChanged
 * All D-pad movement, focus, and expand/collapse animation happens entirely
 * in real Android views (see TVNavRailView) without touching this module.
 */
class NavRailModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), NavRailManager.Bridge {

    init {
        NavRailManager.bridge = this
    }

    override fun getName(): String = "NavRailModule"

    private fun emit(event: String, params: com.facebook.react.bridge.WritableMap?) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(event, params)
        } catch (e: Exception) {
            // Context torn down mid-transition (e.g. Fast Refresh) -- safe to drop.
        }
    }

    override fun onRouteChanged(route: String) {
        emit("NavRail:onRouteChanged", Arguments.createMap().apply { putString("route", route) })
    }

    override fun onRouteReselected(route: String) {
        emit("NavRail:onRouteReselected", Arguments.createMap().apply { putString("route", route) })
    }

    override fun onExpandedChanged(expanded: Boolean) {
        emit("NavRail:onExpandedChanged", Arguments.createMap().apply { putBoolean("expanded", expanded) })
    }

    @ReactMethod
    fun setActiveRoute(route: String) {
        UiThreadUtil.runOnUiThread { NavRailManager.setActiveRoute(route) }
    }

    @ReactMethod
    fun focusRoute(route: String) {
        UiThreadUtil.runOnUiThread { NavRailManager.focusRoute(route) }
    }

    @ReactMethod
    fun setVisible(visible: Boolean) {
        UiThreadUtil.runOnUiThread { NavRailManager.setVisible(visible) }
    }

    /**
     * `reactTag` is a React node handle, e.g. from `findNodeHandle(ref)` on
     * the JS side (see `src/lib/native/NavRail.ts`). We resolve it to the
     * real underlying Android View and hand that to the rail so it can wire
     * a genuine `nextFocusRightId` -- this is the one place native code
     * reaches back *into* the RN view tree, and it only ever reads a View
     * reference, it never re-parents or mutates RN's own management of it.
     */
    @ReactMethod
    fun registerRouteHandle(route: String, reactTag: Double) {
        val tag = reactTag.toInt()
        val ctx = reactApplicationContext
        UiThreadUtil.runOnUiThread {
            try {
                val uiManager = UIManagerHelper.getUIManagerForReactTag(ctx, tag)
                val view = uiManager?.resolveView(tag)
                NavRailManager.registerRouteHandle(route, view)
            } catch (e: Exception) {
                // The view may not be resolvable yet (mid-mount/unmount) --
                // the next registerRouteHandle call (screens re-register on
                // every relevant layout effect) will pick it up.
            }
        }
    }

    @ReactMethod
    fun clearRouteHandle(route: String) {
        UiThreadUtil.runOnUiThread { NavRailManager.registerRouteHandle(route, null) }
    }

    // NativeEventEmitter bookkeeping methods RN expects to exist, even
    // though we don't need to do anything with them.
    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}
}

class NavRailPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(NavRailModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
