import { useCallback, useEffect, useReducer, useRef } from 'react';
import { findNodeHandle } from 'react-native';

/**
 * Generic version of the "remember where I was, come back to it" plumbing
 * TVHomeScreen pioneered for the native nav rail's entry/return-focus
 * contract (see App.tsx's `entryHandleGetterRef` / `entryReturnTriggerRef`
 * and TVNavRailView.kt's `requestRightNavigation()`).
 *
 * Two things need to happen for a route's content to cooperate with the
 * rail:
 *  1. Whenever the active route changes, App.tsx asks the new screen "what
 *     node should Right land on if the rail is re-entered right now?" --
 *     that's the *entry* handle getter.
 *  2. Whenever the user presses Right (or re-presses Enter) on the rail's
 *     already-active row, App.tsx asks the screen to put real Android focus
 *     back wherever the user last left it -- that's the *return* trigger.
 *
 * Both need a live pointer to "whatever the user was last focused on",
 * which the screen itself tracks (usually a plain module-level variable so
 * it survives the screen unmounting/remounting on route changes, exactly
 * like TVHomeScreen's `lastFocusedKey`). This hook only owns the two-way
 * wiring to App.tsx and the little remount-nonce trick needed to force a
 * real focus() call on an item that already has focus-caching state --
 * *not* the "what was last focused" bookkeeping itself, since that varies
 * per screen (row+col for a grid, a flat key for a list, etc).
 */
export function useTVEntryFocus(
  getLastFocusedKey: () => string | null,
  onRegisterEntryHandleGetter?: (getter: (() => number | null) | null) => void,
  onRegisterReturnFocusTrigger?: (trigger: (() => void) | null) => void
) {
  // key -> the real native View currently rendered for that key. Screens
  // populate this via `setItemRef` from every relevant item's `ref` prop.
  const itemRefsRef = useRef<Record<string, any>>({});

  useEffect(() => {
    onRegisterEntryHandleGetter?.(() => {
      const key = getLastFocusedKey();
      const node = key ? itemRefsRef.current[key] : null;
      return node ? findNodeHandle(node) : null;
    });
    return () => onRegisterEntryHandleGetter?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRegisterEntryHandleGetter]);

  // `hasTVPreferredFocus` only fires a real focus() the moment an element
  // is first mounted -- flipping it true on an already-mounted element does
  // nothing. Bumping this nonce forces exactly the item the user was last
  // on to remount (via `keyFor`), so its `hasTVPreferredFocus` re-triggers
  // a real focus() the instant the rail hands focus back to content.
  const refocusRef = useRef<{ key: string | null; nonce: number }>({ key: null, nonce: 0 });
  const [, forceRerenderForRefocus] = useReducer((n) => n + 1, 0);

  useEffect(() => {
    onRegisterReturnFocusTrigger?.(() => {
      const key = getLastFocusedKey();
      if (!key) return;
      refocusRef.current = { key, nonce: refocusRef.current.nonce + 1 };
      forceRerenderForRefocus();
    });
    return () => onRegisterReturnFocusTrigger?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRegisterReturnFocusTrigger]);

  const setItemRef = useCallback((key: string, node: any) => {
    itemRefsRef.current[key] = node ?? undefined;
  }, []);

  /** Use as this item's React `key` so it remounts when it needs to reclaim real focus. */
  const keyFor = useCallback((key: string) => {
    return refocusRef.current.key === key ? `${key}-r${refocusRef.current.nonce}` : key;
  }, []);

  /** Use as this item's `hasTVPreferredFocus`, with the screen's own default for a fresh mount. */
  const shouldPreferFocus = useCallback(
    (key: string, defaultValue: boolean) => {
      const lastKey = getLastFocusedKey();
      return lastKey ? lastKey === key : defaultValue;
    },
    [getLastFocusedKey]
  );

  return { setItemRef, keyFor, shouldPreferFocus };
}
