package com.vega

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import androidx.core.graphics.PathParser
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

    /**
     * True while the row is selected/focused. Only the Addons glyph cares:
     * it swaps from the outline puzzle piece to the solid one.
     */
    var highlighted: Boolean = false
        set(value) {
            if (field != value) {
                field = value
                invalidate()
            }
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
        // Stremio addons glyph (Ionicons "extension-puzzle"): outline when
        // idle, solid when the row is selected/focused. Both paths live in a
        // 512x512 viewBox; scale the canvas so stroke width (32 units) and
        // geometry scale together, inset slightly to match the other icons.
        val scale = (w * 0.9f) / ADDONS_VIEWBOX
        val inset = w * 0.05f
        val insetY = h * 0.05f
        c.save()
        c.translate(inset, insetY)
        c.scale(scale, scale)
        if (highlighted) {
            c.drawPath(addonsFilledPath, fillPaint)
        } else {
            val saved = strokePaint.strokeWidth
            strokePaint.strokeWidth = ADDONS_OUTLINE_STROKE
            c.drawPath(addonsOutlinePath, strokePaint)
            strokePaint.strokeWidth = saved
        }
        c.restore()
    }

    private val addonsFilledPath: Path by lazy {
        PathParser.createPathFromPathData(ADDONS_FILLED_PATH_DATA)
    }
    private val addonsOutlinePath: Path by lazy {
        PathParser.createPathFromPathData(ADDONS_OUTLINE_PATH_DATA)
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

    private companion object {
        const val ADDONS_VIEWBOX = 512f
        const val ADDONS_OUTLINE_STROKE = 32f

        // From addons.svg (solid) and addons-outline.svg (stroke width 32).
        const val ADDONS_FILLED_PATH_DATA =
            "M345.1 480H274c-2.36.01-4.71-.45-6.89-1.36s-4.16-2.25-5.81-3.94A18 18 0 0 1 256 462v-27.7c.03-4.26-.82-8.49-2.5-12.4a32.3 32.3 0 0 0-7.19-10.4c-7.81-7.6-19.11-11.81-30.91-11.5-21.4.49-39.4 19.3-39.4 41.1V462c.01 2.36-.45 4.71-1.36 6.89s-2.25 4.16-3.94 5.81A18.07 18.07 0 0 1 158 480H87.6a55.67 55.67 0 0 1-39.36-16.26 55.64 55.64 0 0 1-16.34-39.35V354a18.1 18.1 0 0 1 5.29-12.7c3.38-3.38 7.94-5.27 12.71-5.3h27.7c9.2 0 18.1-3.9 25.1-11 3.9-3.92 7-8.58 9.1-13.7a40.7 40.7 0 0 0 3.1-16.2c-.3-21.2-17.7-39.1-38.11-39.1H50c-2.36.01-4.71-.45-6.9-1.36-2.17-.91-4.15-2.25-5.81-3.94A18 18 0 0 1 32 238v-70.4a55.8 55.8 0 0 1 4.2-21.3 53.7 53.7 0 0 1 12.1-18A55.7 55.7 0 0 1 87.6 112h55.2c2.13.01 4.18-.81 5.7-2.31.73-.74 1.33-1.63 1.72-2.62.4-.97.6-2.02.58-3.07v-6.5a64.7 64.7 0 0 1 5.1-25.3 66.6 66.6 0 0 1 14.5-21.4c6.21-6.11 13.6-10.9 21.7-14.1 8.08-3.2 16.71-4.8 25.4-4.7 35.5.6 64.4 30.4 64.4 66.3v5.7c-.03 1.59.42 3.16 1.3 4.47a7.77 7.77 0 0 0 3.62 2.96c.98.39 2.04.59 3.08.57h55.2c7.22-.01 14.35 1.42 21 4.2a54.96 54.96 0 0 1 29.7 29.7 54.3 54.3 0 0 1 4.2 21v55.19c-.03 1.6.42 3.17 1.31 4.49a7.73 7.73 0 0 0 3.61 2.95c.98.39 2.04.59 3.08.57h5.7c36.6 0 66.31 29 66.31 64.6 0 36.6-29.41 66.4-65.51 66.4H408c-2.13-.01-4.16.82-5.7 2.3a7.9 7.9 0 0 0-1.71 2.62 7.6 7.6 0 0 0-.59 3.08v56c.01 7.2-1.42 14.35-4.2 21a54.96 54.96 0 0 1-29.7 29.7 53.9 53.9 0 0 1-21 4.2"

        const val ADDONS_OUTLINE_PATH_DATA =
            "M413.7 246.11h-27.69c-.54-.01-1.04-.23-1.41-.6s-.59-.88-.6-1.4v-77.2a38.9 38.9 0 0 0-11.4-27.5 38.92 38.92 0 0 0-27.5-11.4h-77.2c-.53-.01-1.03-.24-1.4-.6-.37-.37-.59-.87-.6-1.4v-27.7c0-27.1-21.5-49.9-48.6-50.3-6.57-.1-13.09 1.09-19.2 3.5a49.5 49.5 0 0 0-16.4 10.7 49.9 49.9 0 0 0-11.01 16.2 49.05 49.05 0 0 0-3.89 19.19v28.51c-.01.53-.23 1.03-.6 1.4s-.87.59-1.4.6H87.6c-10.5 0-20.57 4.17-28 11.6a39.55 39.55 0 0 0-11.6 28v70.4c.01.53.23 1.03.6 1.4a2 2 0 0 0 1.4.6h26.89c29.41 0 53.71 25.5 54.1 54.8.4 29.9-23.49 57.2-53.29 57.2H50a2 2 0 0 0-1.4.6c-.37.37-.59.86-.6 1.4v70.4a39.57 39.57 0 0 0 11.6 28c7.43 7.43 17.5 11.6 28 11.6H158c.52-.01 1.03-.23 1.4-.6.37-.38.59-.87.6-1.4v-20.9c0-30.31 24.8-56.4 55-57.1 30.1-.7 57 20.29 57 50.3v27.7c.01.53.23 1.02.6 1.4.37.37.87.59 1.4.6h71.1a38.923 38.923 0 0 0 38.9-38.9v-78c.01-.53.23-1.03.6-1.4s.87-.59 1.41-.6h28.49c27.6 0 49.5-22.7 49.5-50.4 0-27.71-23.19-48.7-50.3-48.7"
    }
}
