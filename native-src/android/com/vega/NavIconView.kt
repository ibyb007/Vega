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
        val path = Path()
        path.moveTo(w * 0.5f, h * 0.08f)
        path.lineTo(w * 0.92f, h * 0.42f)
        path.lineTo(w * 0.5f, h * 0.08f)
        path.moveTo(w * 0.08f, h * 0.42f)
        path.lineTo(w * 0.5f, h * 0.08f)
        c.drawPath(path, strokePaint)

        val roof = Path()
        roof.moveTo(w * 0.16f, h * 0.46f)
        roof.lineTo(w * 0.5f, h * 0.14f)
        roof.lineTo(w * 0.84f, h * 0.46f)
        c.drawPath(roof, strokePaint)

        val body = RectF(w * 0.22f, h * 0.46f, w * 0.78f, h * 0.9f)
        c.drawRoundRect(body, w * 0.04f, w * 0.04f, strokePaint)

        val door = RectF(w * 0.42f, h * 0.62f, w * 0.58f, h * 0.9f)
        c.drawRect(door, strokePaint)
    }

    private fun drawDiscover(c: Canvas, w: Float, h: Float) {
        val cx = w * 0.5f
        val cy = h * 0.5f
        val r = w * 0.41f
        c.drawCircle(cx, cy, r, strokePaint)

        val tipNeX = cx + w * 0.28f
        val tipNeY = cy - h * 0.28f
        val tipSwX = cx - w * 0.28f
        val tipSwY = cy + h * 0.28f

        val waistNwX = cx - w * 0.085f
        val waistNwY = cy - h * 0.085f
        val waistSeX = cx + w * 0.085f
        val waistSeY = cy + h * 0.085f

        val neArrow = Path().apply {
            moveTo(tipNeX, tipNeY)
            lineTo(waistNwX, waistNwY)
            lineTo(cx, cy)
            lineTo(waistSeX, waistSeY)
            close()
        }
        c.drawPath(neArrow, fillPaint)

        val swArrow = Path().apply {
            moveTo(tipSwX, tipSwY)
            lineTo(waistNwX, waistNwY)
            lineTo(cx, cy)
            lineTo(waistSeX, waistSeY)
            close()
        }
        val origStroke = strokePaint.strokeWidth
        strokePaint.strokeWidth = w * 0.065f
        c.drawPath(swArrow, strokePaint)

        c.drawCircle(cx, cy, w * 0.065f, strokePaint)
        strokePaint.strokeWidth = origStroke
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
        // Solid-filled puzzle piece: a rounded square body with an outward
        // knob on the top and right edges, and an inward socket (bite) on
        // the bottom and left edges -- built with path boolean ops so each
        // bump/notch is a clean circle union/difference rather than a
        // hand-stitched arc, matching the reference glyph.

        // Outer bounds of the main square body
        val left = w * 0.22f
        val right = w * 0.82f
        val top = h * 0.22f
        val bottom = h * 0.82f
        val cx = (left + right) / 2f
        val cy = (top + bottom) / 2f
        val cornerR = w * 0.05f
        val knobR = w * 0.155f

        val piece = Path()
        piece.addRoundRect(RectF(left, top, right, bottom), cornerR, cornerR, Path.Direction.CW)

        // Top knob (outward bump), centered on the top edge
        val topKnob = Path().apply { addCircle(cx, top, knobR, Path.Direction.CW) }
        piece.op(topKnob, Path.Op.UNION)

        // Right knob (outward bump), centered on the right edge
        val rightKnob = Path().apply { addCircle(right, cy, knobR, Path.Direction.CW) }
        piece.op(rightKnob, Path.Op.UNION)

        // Left socket (inward notch), centered on the left edge
        val leftSocket = Path().apply { addCircle(left, cy, knobR, Path.Direction.CW) }
        piece.op(leftSocket, Path.Op.DIFFERENCE)

        // Bottom socket (inward notch), centered on the bottom edge
        val bottomSocket = Path().apply { addCircle(cx, bottom, knobR, Path.Direction.CW) }
        piece.op(bottomSocket, Path.Op.DIFFERENCE)

        c.drawPath(piece, fillPaint)
    }

    private fun drawSettings(c: Canvas, w: Float, h: Float) {
        val cx = w * 0.5f
        val cy = h * 0.5f
        val outerR = w * 0.32f
        val innerR = w * 0.14f
        val toothCount = 8
        val toothHeight = w * 0.11f
        val toothBaseHalf = w * 0.065f
        val toothTipHalf = w * 0.042f

        // Trapezoid teeth (wider at the base, narrower at the tip) fused
        // onto the ring via boolean union -- a proper cog silhouette
        // instead of rectangular blocks stuck on the outside.
        val gear = Path()
        gear.addCircle(cx, cy, outerR, Path.Direction.CW)
        for (i in 0 until toothCount) {
            val tooth = Path()
            tooth.moveTo(-toothBaseHalf, -outerR)
            tooth.lineTo(toothBaseHalf, -outerR)
            tooth.lineTo(toothTipHalf, -outerR - toothHeight)
            tooth.lineTo(-toothTipHalf, -outerR - toothHeight)
            tooth.close()
            val m = android.graphics.Matrix()
            m.postRotate((360f / toothCount) * i)
            m.postTranslate(cx, cy)
            tooth.transform(m)
            gear.op(tooth, Path.Op.UNION)
        }

        val hole = Path()
        hole.addCircle(cx, cy, innerR, Path.Direction.CW)
        gear.op(hole, Path.Op.DIFFERENCE)

        c.drawPath(gear, fillPaint)
    }

    private fun drawLogo(c: Canvas, w: Float, h: Float) {
        val cx = w * 0.5f
        val cy = h * 0.5f
        val r = w * 0.46f
        c.drawCircle(cx, cy, r, strokePaint)
        val play = Path()
        val pr = r * 0.5f
        play.moveTo(cx - pr * 0.5f, cy - pr * 0.8f)
        play.lineTo(cx - pr * 0.5f, cy + pr * 0.8f)
        play.lineTo(cx + pr * 0.9f, cy)
        play.close()
        c.drawPath(play, fillPaint)
    }
}
