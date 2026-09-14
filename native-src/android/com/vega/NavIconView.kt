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
        val origJoin = strokePaint.strokeJoin
        strokePaint.strokeJoin = Paint.Join.ROUND

        // Outer bounds of the main square body
        val left = w * 0.24f
        val right = w * 0.76f
        val top = h * 0.24f
        val bottom = h * 0.76f
        val cx = (left + right) / 2f
        val cy = (top + bottom) / 2f
        val cornerR = w * 0.04f

        // Tab and socket dimensions matching the reference image
        val headR = w * 0.145f
        val offset = w * 0.07f
        val neckHalf = w * 0.082f

        val path = Path()

        // 1. Top-left corner
        path.moveTo(left, top + cornerR)
        path.quadTo(left, top, left + cornerR, top)

        // 2. Top edge -> Outward knob
        path.lineTo(cx - neckHalf, top)
        val topHeadCy = top - offset
        path.arcTo(
            RectF(cx - headR, topHeadCy - headR, cx + headR, topHeadCy + headR),
            145f,
            250f,
            false
        )
        path.lineTo(right - cornerR, top)

        // 3. Top-right corner
        path.quadTo(right, top, right, top + cornerR)

        // 4. Right edge -> Inward socket
        path.lineTo(right, cy - neckHalf)
        val rightHeadCx = right - offset
        path.arcTo(
            RectF(rightHeadCx - headR, cy - headR, rightHeadCx + headR, cy + headR),
            -125f,
            -250f,
            false
        )
        path.lineTo(right, bottom - cornerR)

        // 5. Bottom-right corner
        path.quadTo(right, bottom, right - cornerR, bottom)

        // 6. Bottom edge -> Inward socket
        path.lineTo(cx + neckHalf, bottom)
        val bottomHeadCy = bottom - offset
        path.arcTo(
            RectF(cx - headR, bottomHeadCy - headR, cx + headR, bottomHeadCy + headR),
            -35f,
            -250f,
            false
        )
        path.lineTo(left + cornerR, bottom)

        // 7. Bottom-left corner
        path.quadTo(left, bottom, left, bottom - cornerR)

        // 8. Left edge -> Outward knob
        path.lineTo(left, cy + neckHalf)
        val leftHeadCx = left - offset
        path.arcTo(
            RectF(leftHeadCx - headR, cy - headR, leftHeadCx + headR, cy + headR),
            55f,
            250f,
            false
        )
        path.lineTo(left, top + cornerR)
        path.close()

        c.drawPath(path, strokePaint)
        strokePaint.strokeJoin = origJoin
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
