import { useCallback, useRef, useState } from 'react';
import { findNodeHandle } from 'react-native';

// Wires explicit `nextFocusLeft`/`nextFocusRight` between adjacent items in
// a horizontal row.
//
// Why this is needed: on Android, a `HorizontalScrollView` (what RN's
// `<ScrollView horizontal>` renders to) can intercept D-pad LEFT/RIGHT at
// its own boundary to decide whether to scroll, before the OS's default
// geometric focus search gets a chance to look at siblings -- and even
// mid-row, transformed/scaled focused items can make that geometric search
// pick the wrong neighbour or nothing at all. Setting each item's native
// `nextFocusLeft`/`nextFocusRight` id explicitly bypasses that guesswork
// entirely: Android's `View.focusSearch()` always honors an explicit id
// first, before falling back to any default algorithm.
export const useFocusChain = (length: number) => {
  const nodesRef = useRef<Array<any>>([]);
  // Bumping this forces a re-render once refs are attached, so the first
  // paint's handles (all null) don't get permanently baked into the
  // `nextFocusLeft`/`nextFocusRight` props.
  const [, forceUpdate] = useState(0);

  const setNodeRef = useCallback((index: number) => (node: any) => {
    nodesRef.current[index] = node;
    forceUpdate((n) => n + 1);
  }, []);

  const getFocusProps = useCallback(
    (index: number, opts?: { nextFocusLeft?: number }) => {
      const leftNode = index > 0 ? nodesRef.current[index - 1] : null;
      const rightNode =
        index < length - 1 ? nodesRef.current[index + 1] : null;

      const leftHandle = leftNode ? findNodeHandle(leftNode) : undefined;
      const rightHandle = rightNode ? findNodeHandle(rightNode) : undefined;

      return {
        ref: setNodeRef(index),
        nextFocusLeft: leftHandle ?? opts?.nextFocusLeft,
        nextFocusRight: rightHandle ?? undefined,
      };
    },
    [length, setNodeRef],
  );

  return { getFocusProps };
};
