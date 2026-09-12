package com.vega

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View

/**
 * The six rail glyphs (+ the brand mark) drawn directly with Canvas paths so the
 * native rail needs zero drawable/vector resources to ship. Visual weight is
 * tuned to roughly match the MaterialCommunityIcons outline glyphs the old JS
 * rail used (magnify, home-variant, compass-outline, database-outline,
 * puzzle-outline, cog-outline, play-circle) -- swap this out for real
 * VectorDrawables later if you want pixel-perfect parity.
 */
enum class NavIcon {
    SEARCH, HOME, DISCOVER, SOURCES, ADDONS, SETTINGS, LOGO
}

class NavIconView(context: Context) : View(context) {

    var iconType: NavIcon = NavIcon.HOME
        set(value) {
            field = value
            invalidate()
        }

    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }

    fun setColor(color: Int) {
        strokePaint.color = color
        fillPaint.color = color
        invalidate()
    }

    init {
        setColor(Color.parseColor("#6B7280"))
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val strokeW = w * 0.09f
        strokePaint.strokeWidth = strokeW

        when (iconType) {
            NavIcon.SEARCH -> drawSearch(canvas, w, h)
            NavIcon.HOME -> drawHome(canvas, w, h)
            NavIcon.DISCOVER -> drawDiscover(canvas, w, h)
            NavIcon.SOURCES -> drawSources(canvas, w, h)
            NavIcon.ADDONS -> drawAddons(canvas, w, h)
            NavIcon.SETTINGS -> drawSettings(canvas, w, h)
            NavIcon.LOGO -> drawLogo(canvas, w, h)
        }
    }

    private fun drawSearch(c: Canvas, w: Float, h: Float) {
        val r = w * 0.32f
        val cx = w * 0.42f
        val cy = h * 0.42f
        c.drawCircle(cx, cy, r, strokePaint)
        val angle = Math.toRadians(45.0)
        val startX = cx + (r * Math.cos(angle)).toFloat()
        val startY = cy + (r * Math.sin(angle)).toFloat()
        c.drawLine(startX, startY, w * 0.88f, h * 0.88f, strokePaint)
    }

    private fun drawHome(c: Canvas, w: Float, h: Float) {
        val roof = Path()
        roof.moveTo(w * 0.12f, h * 0.48f)
        roof.lineTo(w * 0.5f, h * 0.1f)
        roof.lineTo(w * 0.88f, h * 0.48f)
        c.drawPath(roof, strokePaint)

        val body = RectF(w * 0.22f, h * 0.46f, w * 0.78f, h * 0.9f)
        c.drawRoundRect(body, w * 0.04f, w * 0.04f, strokePaint)

        val door = RectF(w * 0.42f, h * 0.62f, w * 0.58f, h * 0.9f)
        c.drawRect(door, strokePaint)
    }

    private fun drawDiscover(c: Canvas, w: Float, h: Float) {
        val cx = w * 0.5f
        val cy = h * 0.5f
        val r = w * 0.42f
        c.drawCircle(cx, cy, r, strokePaint)

        val needle = Path()
        needle.moveTo(cx + r * 0.55f, cy - r * 0.55f)
        needle.lineTo(cx - r * 0.15f, cy + r * 0.1f)
        needle.lineTo(cx - r * 0.55f, cy + r * 0.55f)
        needle.lineTo(cx + r * 0.15f, cy - r * 0.1f)
        needle.close()
        c.drawPath(needle, fillPaint)
    }

    private fun drawSources(c: Canvas, w: Float, h: Float) {
        // Three stacked ellipses -- the classic "database/cylinder" glyph.
        val left = w * 0.16f
        val right = w * 0.84f
        val rx = (right - left) / 2f
        val ry = h * 0.12f
        val tops = floatArrayOf(h * 0.16f, h * 0.42f, h * 0.68f)
        for (topY in tops) {
            val oval = RectF(left, topY, right, topY + ry * 2f)
            c.drawOval(oval, strokePaint)
        }
        c.drawLine(left, tops[0] + ry, left, tops[2] + ry, strokePaint)
        c.drawLine(right, tops[0] + ry, right, tops[2] + ry, strokePaint)
    }

    private fun drawAddons(c: Canvas, w: Float, h: Float) {
        // Rounded square body with a puzzle "knob" bump on one edge.
        val body = RectF(w * 0.16f, h * 0.16f, w * 0.84f, h * 0.84f)
        c.drawRoundRect(body, w * 0.08f, w * 0.08f, strokePaint)
        val knobR = w * 0.12f
        c.drawCircle(w * 0.84f, h * 0.5f, knobR, strokePaint)
    }

    private fun drawSettings(c: Canvas, w: Float, h: Float) {
        val cx = w * 0.5f
        val cy = h * 0.5f
        val outerR = w * 0.4f
        val innerR = w * 0.16f
        c.drawCircle(cx, cy, innerR, strokePaint)

        val toothLen = w * 0.14f
        val toothWidth = w * 0.1f
        c.save()
        for (i in 0 until 8) {
            c.save()
            c.rotate((360f / 8f) * i, cx, cy)
            val tooth = RectF(
                cx - toothWidth / 2f,
                cy - outerR,
                cx + toothWidth / 2f,
                cy - outerR + toothLen
            )
            c.drawRoundRect(tooth, toothWidth * 0.3f, toothWidth * 0.3f, fillPaint)
            c.restore()
        }
        c.restore()
    }

    // Deliberately ignores the strokePaint/fillPaint colors set via
    // setColor() -- the brand mark is always a solid accent-purple badge
    // with a white play glyph, regardless of what color a focus/active
    // state would otherwise tint a nav icon.
    private fun drawLogo(c: Canvas, w: Float, h: Float) {
        val cx = w * 0.5f
        val cy = h * 0.5f
        val r = w * 0.5f

        val badgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.FILL
            color = LOGO_ACCENT
        }
        c.drawCircle(cx, cy, r, badgePaint)

        val glyphPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.FILL
            color = Color.WHITE
        }
        val play = Path()
        val pr = r * 0.52f
        play.moveTo(cx - pr * 0.55f, cy - pr * 0.85f)
        play.lineTo(cx - pr * 0.55f, cy + pr * 0.85f)
        play.lineTo(cx + pr * 0.95f, cy)
        play.close()
        c.drawPath(play, glyphPaint)
    }

    companion object {
        private val LOGO_ACCENT = Color.parseColor("#8A5CF6")
    }
}
