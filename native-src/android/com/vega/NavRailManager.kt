package com.vega

import android.app.Activity
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import java.lang.ref.WeakReference

/**
 * Owns the single native [TVNavRailView] instance for the app and grafts it
 * directly into the Activity's own content view, as a real sibling of the
 * ReactRootView -- not inside the RN tree at all. That's what gives the rail
 * genuine `View.requestFocus()` / `nextFocusLeft/Right/Up/Down` semantics
 * with no bridge in the loop.
 *
 * Call [attachToActivity] once, from `MainActivity.onContentChanged()` (see
 * `plugins/with-native-nav-rail.js`, which wires that call in automatically).
 */
object NavRailManager {

    interface Bridge {
        fun onRouteChanged(route: String)
        fun onRouteReselected(route: String)
        fun onExpandedChanged(expanded: Boolean)
    }

    var bridge: Bridge? = null

    private var activityRef: WeakReference<Activity>? = null
    private var railRef: WeakReference<TVNavRailView>? = null

    fun attachToActivity(activity: Activity) {
        val existingActivity = activityRef?.get()
        if (existingActivity != null && existingActivity !== activity) {
            // The previous Activity instance was never cleanly detached --
            // most likely it finished (Back-while-rail-focused ->
            // finishAffinity()) without the process actually dying, and
            // we're now attaching a brand new Activity in that same
            // still-alive process. The old rail/activity are stale even
            // though their WeakReferences haven't been GC'd yet -- drop
            // them before attaching fresh, or the check below wrongly
            // thinks a rail is already attached and no-ops forever.
            reset()
        }
        if (railRef?.get() != null) return

        val decorContent = activity.findViewById<ViewGroup>(android.R.id.content) ?: return
        if (decorContent.childCount == 0) {
            // ReactRootView hasn't been attached under android.R.id.content yet
            // on this pass -- try again on the next frame.
            decorContent.post { attachToActivity(activity) }
            return
        }

        val reactRoot = decorContent.getChildAt(0)
        decorContent.removeView(reactRoot)

        val wrapper = FrameLayout(activity)
        wrapper.addView(
            reactRoot,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        )

        val rail = TVNavRailView(activity)
        rail.listener = object : TVNavRailView.Listener {
            override fun onRouteChanged(route: String) {
                bridge?.onRouteChanged(route)
            }

            override fun onRouteReselected(route: String) {
                bridge?.onRouteReselected(route)
            }

            override fun onExpandedChanged(expanded: Boolean) {
                bridge?.onExpandedChanged(expanded)
            }
        }
        val railLp = FrameLayout.LayoutParams(rail.collapsedWidthPx(), FrameLayout.LayoutParams.MATCH_PARENT)
        railLp.gravity = Gravity.START or Gravity.TOP
        wrapper.addView(rail, railLp)
        rail.bringToFront()

        decorContent.addView(
            wrapper,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        )

        activityRef = WeakReference(activity)
        railRef = WeakReference(rail)
    }

    /** True while focus currently sits somewhere inside the rail. */
    fun isRailFocused(): Boolean = railRef?.get()?.hasFocus() == true

    /**
     * Mirrors the old JS `navExpandedRef.current` check: Back should exit the
     * app outright when the rail holds focus, before any screen gets a
     * chance to handle it. `MainActivity.dispatchKeyEvent` calls this first,
     * ahead of the RN bridge, so the ordering guarantee JS used to rely on
     * (see App.tsx's hardwareBackPress comment) now holds natively.
     */
    fun shouldExitOnBack(): Boolean = isRailFocused()

    fun setActiveRoute(route: String) {
        railRef?.get()?.setActiveRouteFromJs(route)
    }

    fun focusRoute(route: String) {
        railRef?.get()?.focusRoute(route)
    }

    fun setVisible(visible: Boolean) {
        val rail = railRef?.get() ?: return
        if (!visible && rail.hasFocus()) {
            // Don't strand focus inside a rail that's about to disappear --
            // hand it back to the content behind it first.
            (rail.parent as? ViewGroup)?.let { parent ->
                for (i in 0 until parent.childCount) {
                    val child = parent.getChildAt(i)
                    if (child !== rail) {
                        child.requestFocus()
                        break
                    }
                }
            }
        }
        rail.visibility = if (visible) View.VISIBLE else View.GONE
    }

    fun registerRouteHandle(route: String, view: View?) {
        railRef?.get()?.registerRouteTarget(route, view)
    }

    /**
     * Call from `MainActivity.onDestroy()`. Clears our static state *only*
     * if the destroying Activity is the one we're currently tracking, so an
     * unrelated/old call can't blow away a newer, already-attached rail.
     * This is the other half of the stale-singleton fix in
     * [attachToActivity]: with this in place the happy path (process
     * actually dies or the new Activity attaches first) never even needs
     * the defensive check there, but we keep both since Activity teardown
     * ordering on TV launchers isn't something to fully trust.
     */
    fun detachFromActivity(activity: Activity) {
        if (activityRef?.get() === activity) {
            reset()
        }
    }

    private fun reset() {
        railRef?.get()?.listener = null
        railRef = null
        activityRef = null
    }
}
