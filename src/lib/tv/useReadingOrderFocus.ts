import { useCallback, useLayoutEffect, useReducer, useRef } from 'react';
import { findNodeHandle } from 'react-native';

/**
 * D-pad Left/Right "reading order" navigation for a full-screen page that has
 * NO nav rail beside it and is laid out as a vertical stack of rows (each row
 * holding one or more focusable items):
 *
 *   - Left  from the first item of a row -> last item of the row above
 *   - Right from the last item of a row  -> first item of the row below
 *   - Left on the very first item / Right on the very last item -> nothing
 *     happens, focus stays where it is.
 *
 * Because rows are read top-to-bottom / left-to-right, all of that is just
 * "Left = previous item in reading order, Right = next item", so one flat
 * chain covers every case (a row of 1 item, a wrapped row of chips, a
 * horizontal row of source cards...). Up/Down are untouched and keep using
 * Android's normal geometric focus search.
 *
 * Why explicit ids instead of default focus search: Android's default search
 * only ever looks *within* the current row for Left/Right (and a horizontal
 * ScrollView additionally captures those keys at its own scroll boundary), so
 * it can never step to a neighbouring row on its own. Setting
 * `nextFocusLeft`/`nextFocusRight` explicitly is honoured first by
 * `View.focusSearch()`.
 *
 * IMPORTANT: an explicit next-focus id only resolves to a view that is
 * currently attached to the window. The scroll view holding these items must
 * therefore not use `removeClippedSubviews`, or a neighbour scrolled out of
 * view silently falls back to default search.
 *
 * Usage (inside the screen component, above any early return):
 *   const chain = useReadingOrderFocus();
 *   // in render, before the first item:      chain.beginRender();
 *   // on every focusable, in visual order:   {...chain.propsFor(key)}
 *   // in that item's ref callback:           chain.register(key, node)
 */
export function useReadingOrderFocus() {
  const nodesRef = useRef<Record<string, any>>({});
  // Last native view tag seen per key -- lets `register` tell "same view
  // re-attached by an inline ref callback on re-render" (ignore) from "a
  // genuinely new native view" (re-run so neighbours pick up its new
  // handle). Compared by native tag, not by JS object identity, so it can't
  // loop no matter what the ref callback hands back.
  const seenTagsRef = useRef<Record<string, unknown>>({});
  // Keys in the order they were rendered this pass / order that was last
  // committed (what `propsFor` reads from).
  const renderOrderRef = useRef<string[]>([]);
  const committedOrderRef = useRef<string[]>([]);
  const [, bump] = useReducer((n: number) => n + 1, 0);

  /** Call once at the top of each render pass that renders the chained items. */
  const beginRender = useCallback(() => {
    renderOrderRef.current = [];
  }, []);

  const register = useCallback((key: string, node: any) => {
    if (!node) {
      nodesRef.current[key] = undefined;
      return;
    }
    nodesRef.current[key] = node;
    const marker: unknown = findNodeHandle(node) ?? node;
    if (seenTagsRef.current[key] !== marker) {
      seenTagsRef.current[key] = marker;
      bump();
    }
  }, []);

  const handleOf = (key: string): number | undefined => {
    const node = nodesRef.current[key];
    if (!node) return undefined;
    return findNodeHandle(node) ?? undefined;
  };

  /** Records `key`'s place in reading order and returns its Left/Right links. */
  const propsFor = (key: string): { nextFocusLeft?: number; nextFocusRight?: number } => {
    renderOrderRef.current.push(key);
    const order = committedOrderRef.current;
    const i = order.indexOf(key);
    if (i < 0) return {};
    const self = handleOf(key);
    return {
      // Ends of the chain point at themselves: the key is consumed and
      // focus stays put instead of escaping to some geometric neighbour.
      nextFocusLeft: i > 0 ? handleOf(order[i - 1]) : self,
      nextFocusRight: i < order.length - 1 ? handleOf(order[i + 1]) : self,
    };
  };

  // After every commit: if the set/order of items changed, adopt it and
  // re-render once so each item's links point at its (new) neighbours.
  useLayoutEffect(() => {
    const next = renderOrderRef.current;
    const prev = committedOrderRef.current;
    const same = next.length === prev.length && next.every((k, idx) => k === prev[idx]);
    if (!same) {
      committedOrderRef.current = next.slice();
      bump();
    }
  });

  return { beginRender, register, propsFor };
}
