package com.vega

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.view.View

/**
 * The six rail glyphs (+ the brand mark) drawn directly with Canvas paths so the
 * native rail needs zero drawable/vector resources to ship. The six nav icons
 * come from the supplied SVG pack (see NavIconPaths); only the brand mark is
 * still hand-drawn.
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
     * True while the row is selected/focused: nav icons swap from their
     * outline form to their solid form.
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

        val glyph = NavIconPaths.forIcon(iconType)
        if (glyph == null) {
            strokePaint.strokeWidth = w * 0.09f
            drawLogo(canvas, w, h)
            return
        }
        drawGlyph(canvas, w, h, if (highlighted) glyph.filled else glyph.outline)
    }

    /**
     * Draws SVG-pack shapes: scale the canvas from the 512 viewBox so the
     * geometry and the 32-unit stroke scale together, inset slightly so the
     * glyph (and its stroke) matches the old icons' visual size.
     */
    private fun drawGlyph(c: Canvas, w: Float, h: Float, shapes: List<NavIconPaths.Shape>) {
        val scale = (w * ICON_FILL) / NavIconPaths.VIEWBOX
        c.save()
        c.translate(w * (1f - ICON_FILL) / 2f, h * (1f - ICON_FILL) / 2f)
        c.scale(scale, scale)
        for (shape in shapes) {
            if (shape.stroke) {
                strokePaint.strokeWidth = NavIconPaths.STROKE_WIDTH
                strokePaint.strokeCap = shape.cap
                strokePaint.strokeJoin = shape.join
                strokePaint.strokeMiter = 10f
                c.drawPath(shape.path, strokePaint)
            } else {
                c.drawPath(shape.path, fillPaint)
            }
        }
        c.restore()
        // drawLogo() relies on round caps/joins.
        strokePaint.strokeCap = Paint.Cap.ROUND
        strokePaint.strokeJoin = Paint.Join.ROUND
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
        // Share of the icon box the 512-unit glyph occupies.
        const val ICON_FILL = 0.9f
    }
}
