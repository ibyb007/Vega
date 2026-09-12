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

    private val collapseRunnable = Runnable { collapseIfIdle() }

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
            leftMargin = dp(10)
            topMargin = dp(20)
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
        addView(menuContainer, menuLp)

        indicatorPill = View(context).apply {
            background = GradientDrawable().apply {
                setColor(ACCENT)
                cornerRadius = dp(10).toFloat()
            }
        }
        menuContainer.addView(
            indicatorPill,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(ITEM_HEIGHT_DP))
        )
        (indicatorPill.layoutParams as LinearLayout.LayoutParams).apply {
            // Positioned via translationY, not layout -- it lives in the
            // stack as the first child purely so it paints behind the rows.
        }

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
            // Re-selecting the already-active tab: jump focus straight into
            // that route's registered content entry point, exactly like a
            // real View.requestFocus() call would -- no bridge round-trip
            // needed to know *where* to land.
            registeredTargets[item.id]?.requestFocus()
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
        setExpanded(false)
    }

    private fun animateIndicatorTo(index: Int) {
        val targetY = (index * (ITEM_HEIGHT_DP + ITEM_GAP_DP)).toFloat()
        indicatorPill.animate()
            .translationY(dp(targetY.toInt()).toFloat())
            .setDuration(140)
            .setInterpolator(DecelerateInterpolator())
            .start()
    }

    private fun setExpanded(value: Boolean) {
        if (expanded == value) return
        expanded = value
        listener?.onExpandedChanged(value)

        val fromWidth = width.takeIf { it > 0 } ?: collapsedWidthPx()
        val toWidth = if (value) expandedWidthPx() else collapsedWidthPx()
        val fromColor = if (value) COLLAPSED_BG else EXPANDED_BG
        val toColor = if (value) EXPANDED_BG else COLLAPSED_BG

        if (value) {
            rows.forEach { it.labelView.visibility = View.VISIBLE }
        }

        val animator = ValueAnimator.ofFloat(0f, 1f)
        animator.duration = 140
        animator.interpolator = DecelerateInterpolator()
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
        }
        animator.addListener(object : android.animation.AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: android.animation.Animator) {
                if (!value) rows.forEach { it.labelView.visibility = View.GONE }
            }
        })
        animator.start()
    }

    // ---- external API (driven from NavRailModule / NavRailManager) --------

    fun setActiveRouteFromJs(route: String) {
        activeRoute = route
        val idx = NAV_ITEMS.indexOfFirst { it.id == route }
        if (idx >= 0) animateIndicatorTo(idx)
        rows.forEach { row ->
            val isActive = row.item.id == route
            row.iconView.setColor(if (isActive) ACTIVE_COLOR else INACTIVE_ICON)
            row.labelView.setTextColor(if (isActive) ACTIVE_COLOR else INACTIVE_LABEL)
            row.labelView.setTypeface(row.labelView.typeface, if (isActive) android.graphics.Typeface.BOLD else android.graphics.Typeface.NORMAL)
            // Only the active row's Right D-pad press should leave the rail --
            // mirrors the old JS rail only ever wiring nextFocusRight for
            // `item.id === currentRoute`.
            row.nextFocusRightId = if (isActive) (registeredTargets[route]?.id ?: NO_ID) else NO_ID
        }
    }

    fun registerRouteTarget(route: String, target: View?) {
        if (target == null) {
            registeredTargets.remove(route)
        } else {
            if (target.id == NO_ID) target.id = generateViewId()
            registeredTargets[route] = target
        }
        if (route == activeRoute) {
            rows.firstOrNull { it.item.id == route }?.nextFocusRightId = target?.id ?: NO_ID
        }
    }

    fun focusRoute(route: String) {
        rows.firstOrNull { it.item.id == route }?.requestFocus()
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
        const val COLLAPSE_DELAY_MS = 110L

        val ACCENT = Color.parseColor("#8A5CF6")
        val COLLAPSED_BG = Color.parseColor("#F20A0A0E")
        val EXPANDED_BG = Color.parseColor("#FF111116")
        val INACTIVE_ICON = Color.parseColor("#6B7280")
        val INACTIVE_LABEL = Color.parseColor("#9CA3AF")
        val ACTIVE_COLOR = Color.WHITE
    }
}
