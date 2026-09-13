package com.vega

import android.animation.ArgbEvaluator
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

data class NavItem(val id: String, val label: String, val icon: NavIcon)

private val NAV_ITEMS = listOf(
    NavItem("search", "Search", NavIcon.SEARCH),
    NavItem("home", "Home", NavIcon.HOME),
    NavItem("discover", "Discover", NavIcon.DISCOVER),
    NavItem("sources", "Sources", NavIcon.SOURCES),
    NavItem("addons", "Addons", NavIcon.ADDONS),
    NavItem("settings", "Settings", NavIcon.SETTINGS),
)

/**
 * Fully-native replacement for the old `TVNavigationRail.tsx` JS component.
 *
 * Every row is a real, focusable [View] living directly in the Activity's own
 * view hierarchy (as a sibling of the ReactRootView -- see [NavRailManager]),
 * so Android's normal focus engine handles D-pad Up/Down between rail items,
 * and Left/Right between the rail and RN content, with no JS bridge involved.
 * Only three things ever cross into JS: which route is active, when a route
 * is (re)selected, and whether the rail is currently expanded -- exactly the
 * three signals `App.tsx` used to get from the old component.
 */
class TVNavRailView(context: Context) : FrameLayout(context) {

    interface Listener {
        fun onRouteChanged(route: String)
        fun onRouteReselected(route: String)
        fun onExpandedChanged(expanded: Boolean)
    }

    var listener: Listener? = null

    private var activeRoute: String = "home"
    private var expanded = false
    private var focusDepth = 0

    // route id -> the real Android View that should receive focus when the
    // user presses D-pad Right from that route's rail row (registered from
    // JS via NavRailModule.registerRouteHandle, resolved to a real View on
    // the native side -- see NavRailModule.kt).
    private val registeredTargets = mutableMapOf<String, View>()

    private val rows = mutableListOf<NavItemRow>()
    private lateinit var menuContainer: LinearLayout
    private lateinit var indicatorPill: View
    private lateinit var background2: GradientDrawable
    private lateinit var wordmarkView: TextView

    private val collapseRunnable = Runnable { collapseIfIdle() }
    private val fastInterpolator = DecelerateInterpolator(2.0f)
    private var expandAnimator: ValueAnimator? = null

    private inner class NavItemRow(ctx: Context, val item: NavItem) : LinearLayout(ctx) {
        lateinit var iconView: NavIconView
        lateinit var labelView: TextView

        // The default geometric focus-search for Up/Down inside a vertical
        // rail is already correct, but we pin it explicitly via
        // nextFocusUpId/nextFocusDownId once all rows exist (see wireVerticalChain())
        // so ordering can never be ambiguous regardless of pixel layout.
    }

    init {
        clipChildren = false
        clipToPadding = false
        isFocusableInTouchMode = false

        background2 = GradientDrawable().apply {
            setColor(COLLAPSED_BG)
        }
        background = background2

        val header = FrameLayout(context)
        val logo = NavIconView(context).apply {
            iconType = NavIcon.LOGO
            setColor(ACCENT)
        }
        header.addView(logo, LayoutParams(dp(30), dp(30)).apply {
            // 22dp lines the logo's own left edge up with the row icons'
            // left edge: menuContainer's 8dp margin + each row's 12dp
            // padding + the 2dp the 22dp icon is inset within its 26dp
            // iconBox = 22dp from the rail's left edge.
            leftMargin = dp(22)
            topMargin = dp(20)
        })

        // "VEGA TV" wordmark shown next to the logo, mirroring how the
        // row labels behave: hidden/collapsed to nothing while the rail is
        // collapsed, faded + revealed in step with the expand animation.
        wordmarkView = TextView(context).apply {
            text = "VEGA TV"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            letterSpacing = 0.05f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            visibility = View.GONE
            alpha = 0f
        }
        header.addView(wordmarkView, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
            // 60dp lines the wordmark up with the row labels: 8dp
            // menuContainer margin + 12dp row padding + 26dp iconBox + 14dp
            // label marginStart = 60dp from the rail's left edge.
            leftMargin = dp(60)
            topMargin = dp(26)
        })

        addView(header, LayoutParams(LayoutParams.MATCH_PARENT, dp(56)))

        menuContainer = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
        }
        val menuLp = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT).apply {
            topMargin = dp(76)
            leftMargin = dp(8)
            rightMargin = dp(8)
        }

        indicatorPill = View(context).apply {
            background = GradientDrawable().apply {
                setColor(ACCENT)
                cornerRadius = dp(10).toFloat()
            }
        }
        // Added directly to the root FrameLayout -- NOT to menuContainer --
        // with the same left/right/top offsets menuContainer uses, so index
        // 0's translationY of 0 lines up exactly with the first row. Being
        // a LinearLayout child (the old bug) made it consume real layout
        // space and push every row down by one slot.
        val pillLp = LayoutParams(LayoutParams.MATCH_PARENT, dp(ITEM_HEIGHT_DP)).apply {
            topMargin = dp(76)
            leftMargin = dp(8)
            rightMargin = dp(8)
        }
        addView(indicatorPill, pillLp)

        addView(menuContainer, menuLp)

        NAV_ITEMS.forEachIndexed { index, item ->
            val row = buildRow(item, index)
            rows.add(row)
            menuContainer.addView(row)
        }
        wireVerticalChain()
        setActiveRouteFromJs(activeRoute)
    }

    private fun buildRow(item: NavItem, index: Int): NavItemRow {
        val row = NavItemRow(context, item)
        row.id = generateViewId()
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.isFocusable = true
        row.isFocusableInTouchMode = false
        row.isClickable = true
        row.setPadding(dp(12), 0, dp(12), 0)

        val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(ITEM_HEIGHT_DP))
        lp.topMargin = if (index == 0) 0 else dp(ITEM_GAP_DP)
        row.layoutParams = lp

        val iconBox = FrameLayout(context)
        val icon = NavIconView(context).apply {
            iconType = item.icon
            setColor(INACTIVE_ICON)
        }
        iconBox.addView(icon, LayoutParams(dp(22), dp(22), Gravity.CENTER))
        row.addView(iconBox, LinearLayout.LayoutParams(dp(26), dp(26)))
        row.iconView = icon

        val label = TextView(context).apply {
            text = item.label
            setTextColor(INACTIVE_LABEL)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            visibility = View.GONE
            alpha = 0f
        }
        val labelLp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        )
        labelLp.marginStart = dp(14)
        row.addView(label, labelLp)
        row.labelView = label

        row.setOnFocusChangeListener { _, hasFocus ->
            applyRowStyle(row)
            if (hasFocus) onRowFocused(item, index) else onRowBlurred()
        }
        row.setOnClickListener { onRowSelected(item) }

        return row
    }

    private fun wireVerticalChain() {
        for (i in rows.indices) {
            if (i > 0) rows[i].nextFocusUpId = rows[i - 1].id
            if (i < rows.size - 1) rows[i].nextFocusDownId = rows[i + 1].id
        }
    }

    // ---- focus / selection -------------------------------------------------

    private fun onRowFocused(item: NavItem, index: Int) {
        focusDepth += 1
        removeCallbacks(collapseRunnable)
        setExpanded(true)
        animateIndicatorTo(index)
    }

    private fun onRowBlurred() {
        focusDepth = maxOf(0, focusDepth - 1)
        scheduleCollapse()
    }

    private fun onRowSelected(item: NavItem) {
        focusDepth = 0
        scheduleCollapse()
        if (item.id == activeRoute) {
            // Same live JS round-trip as requestRightNavigation() -- no
            // static cached target, so this can't go stale either.
            listener?.onRouteReselected(item.id)
        } else {
            listener?.onRouteChanged(item.id)
        }
    }

    private fun scheduleCollapse() {
        removeCallbacks(collapseRunnable)
        postDelayed(collapseRunnable, COLLAPSE_DELAY_MS)
    }

    private fun collapseIfIdle() {
        if (focusDepth > 0) return
        // Up/Down browsing moves the indicator pill to whichever row was
        // last focused (see onRowFocused/animateIndicatorTo). If focus then
        // leaves the rail without the active route actually changing --
        // e.g. Right cancels the browse and returns to content for the
        // same tab -- nothing else ever moves the pill back: JS has no
        // reason to call setActiveRouteFromJs again since the route itself
        // never changed, so the pill would otherwise sit on the
        // browsed-to row indefinitely, even after the rail collapses.
        // Re-sync it here, every time focus genuinely leaves the rail, so
        // it always reflects the true active route once you're back in
        // content.
        val idx = NAV_ITEMS.indexOfFirst { it.id == activeRoute }
        if (idx >= 0) animateIndicatorTo(idx)
        setExpanded(false)
    }

    private fun animateIndicatorTo(index: Int) {
        val targetY = (index * (ITEM_HEIGHT_DP + ITEM_GAP_DP)).toFloat()
        indicatorPill.animate()
            .translationY(dp(targetY.toInt()).toFloat())
            .setDuration(INDICATOR_DURATION_MS)
            .setInterpolator(fastInterpolator)
            .start()
    }

    private fun setExpanded(value: Boolean) {
        if (expanded == value) return
        expanded = value
        listener?.onExpandedChanged(value)

        expandAnimator?.cancel()

        // Direction-aware fallback: if the view hasn't been laid out yet
        // (width == 0) and we're collapsing, falling back to the collapsed
        // width here would make the animation start already at its own end
        // state -- a silent jump-cut instead of a visible collapse.
        val fromWidth = width.takeIf { it > 0 } ?: if (value) collapsedWidthPx() else expandedWidthPx()
        val toWidth = if (value) expandedWidthPx() else collapsedWidthPx()
        val fromColor = if (value) COLLAPSED_BG else EXPANDED_BG
        val toColor = if (value) EXPANDED_BG else COLLAPSED_BG

        if (value) {
            rows.forEach { it.labelView.visibility = View.VISIBLE }
            wordmarkView.visibility = View.VISIBLE
        }

        val animator = ValueAnimator.ofFloat(0f, 1f)
        animator.duration = EXPAND_DURATION_MS
        animator.interpolator = fastInterpolator
        val evaluator = ArgbEvaluator()
        animator.addUpdateListener { anim ->
            val t = anim.animatedValue as Float
            val lp = layoutParams
            if (lp != null) {
                lp.width = (fromWidth + (toWidth - fromWidth) * t).toInt()
                layoutParams = lp
            }
            background2.setColor(evaluator.evaluate(t, fromColor, toColor) as Int)
            rows.forEach { it.labelView.alpha = if (value) t else 1f - t }
            wordmarkView.alpha = if (value) t else 1f - t
        }
        animator.addListener(object : android.animation.AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: android.animation.Animator) {
                if (!value) {
                    rows.forEach { it.labelView.visibility = View.GONE }
                    wordmarkView.visibility = View.GONE
                }
            }
        })
        expandAnimator = animator
        animator.start()
    }

    // ---- external API (driven from NavRailModule / NavRailManager) --------

    // A row is drawn bright/highlighted when it currently has real Android
    // focus (you're actively browsing it) OR it's the active route (the
    // "you are here" indicator even while focus has moved elsewhere, e.g.
    // out into content). Everything else stays dim. This used to only
    // check "is active route", so any row you focused while browsing that
    // wasn't also the active route stayed stuck at dim gray sitting on top
    // of the bright accent pill -- which is what read as washed-out/dimmed.
    private fun applyRowStyle(row: NavItemRow) {
        val highlighted = row.hasFocus() || row.item.id == activeRoute
        row.iconView.setColor(if (highlighted) ACTIVE_COLOR else INACTIVE_ICON)
        row.labelView.setTextColor(if (highlighted) ACTIVE_COLOR else INACTIVE_LABEL)
        row.labelView.setTypeface(
            row.labelView.typeface,
            if (highlighted) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL
        )
    }

    fun setActiveRouteFromJs(route: String) {
        activeRoute = route
        val idx = NAV_ITEMS.indexOfFirst { it.id == route }
        if (idx >= 0) animateIndicatorTo(idx)
        rows.forEach { row -> applyRowStyle(row) }
    }

    fun registerRouteTarget(route: String, target: View?) {
        // Kept for JS-side backward compatibility (NavRail.registerRouteHandleTag
        // still calls this), but no longer drives focus directly -- Right
        // from the rail now always goes through the live
        // onRouteReselected -> entryReturnTrigger path instead (see
        // requestRightNavigation()), so a stale cached target here can no
        // longer cause a wrong or oscillating jump.
        if (target == null) {
            registeredTargets.remove(route)
        } else {
            if (target.id == NO_ID) target.id = generateViewId()
            registeredTargets[route] = target
        }
    }

    fun focusRoute(route: String) {
        rows.firstOrNull { it.item.id == route }?.requestFocus()
    }

    /** Always lands on the row for whichever route is currently displayed. */
    fun focusActiveRoute() {
        focusRoute(activeRoute)
    }

    /**
     * Handles DPAD_RIGHT while the rail has focus. Deliberately does NOT
     * jump focus itself via a static `nextFocusRightId` -- that value can
     * only ever reflect a snapshot taken back when `currentRoute` last
     * changed (see App.tsx), so it goes stale the instant you move focus
     * around within the same screen and Right stops landing anywhere near
     * where you actually were. Instead this asks JS live, at the moment of
     * the key press, via the same "give me focus back" event already used
     * when re-selecting the active tab with Enter -- which is presumably
     * backed by each screen's own up-to-date last-focused ref, not a cached
     * native id.
     *
     * Right ALWAYS returns focus to the currently active screen's content,
     * regardless of which row is currently hovered -- matching Stremio,
     * where browsing Up/Down over other rail items and then pressing Right
     * instantly cancels that browse and drops you straight back into
     * content for the tab you were already on. It does not require
     * navigating back to the active row first. Previously, a Right press
     * on a non-active row was swallowed (consumed the key, did nothing
     * visible), which is exactly the "dead" Right press from the recording.
     *
     * Returns true (event consumed) whenever focus was on the rail at all,
     * so Right can never fall through to Android's own geometric search
     * and land somewhere arbitrary in content for the wrong screen.
     */
    fun requestRightNavigation(): Boolean {
        rows.firstOrNull { it.hasFocus() } ?: return false
        listener?.onRouteReselected(activeRoute)
        return true
    }

    fun collapsedWidthPx(): Int = dp(COLLAPSED_WIDTH_DP)
    fun expandedWidthPx(): Int = dp(EXPANDED_WIDTH_DP)

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    companion object {
        const val COLLAPSED_WIDTH_DP = 72
        const val EXPANDED_WIDTH_DP = 220
        const val ITEM_HEIGHT_DP = 46
        const val ITEM_GAP_DP = 6
        const val COLLAPSE_DELAY_MS = 90L
        // Both animations were a flat 140ms with DecelerateInterpolator,
        // which reads as a visible "catch-up" lag next to Stremio's
        // near-instant Up/Down highlight snap. 90ms is short enough to
        // read as instant while still giving the eye a motion cue instead
        // of a hard jump-cut.
        const val INDICATOR_DURATION_MS = 90L
        const val EXPAND_DURATION_MS = 90L

        val ACCENT = Color.parseColor("#8A5CF6")
        val COLLAPSED_BG = Color.parseColor("#F20A0A0E")
        val EXPANDED_BG = Color.parseColor("#FF111116")
        val INACTIVE_ICON = Color.parseColor("#6B7280")
        val INACTIVE_LABEL = Color.parseColor("#9CA3AF")
        val ACTIVE_COLOR = Color.WHITE
    }
}
