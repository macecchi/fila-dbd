import { describe, it, expect } from 'vitest';
import { memo, useState } from 'react';
import { render, act } from '@testing-library/react';
import { ContextMenuProvider, useContextMenu, useContextMenuActions } from './ContextMenuContext';

// Stands in for CharacterRequestCard: memoized, reads only the actions.
let cardRenders = 0;
let showMenu: ReturnType<typeof useContextMenuActions>['show'] | undefined;
const Card = memo(function Card() {
  cardRenders++;
  showMenu = useContextMenuActions().show;
  return null;
});

// Stands in for ContextMenu: reads the state.
let menuState: ReturnType<typeof useContextMenu>['state'] | undefined;
function Menu() {
  menuState = useContextMenu().state;
  return null;
}

// Stands in for CharacterRequestList, which re-renders on every queue change.
let rerenderList: (() => void) | undefined;
function List() {
  const [, setTick] = useState(0);
  rerenderList = () => setTick((t) => t + 1);
  return (
    <ContextMenuProvider>
      <Card />
      <Menu />
    </ContextMenuProvider>
  );
}

describe('ContextMenuProvider', () => {
  it('does not re-render memoized cards when the list re-renders or the menu opens', () => {
    cardRenders = 0;
    render(<List />);
    expect(cardRenders).toBe(1);

    act(() => rerenderList!());
    act(() => rerenderList!());
    expect(cardRenders).toBe(1);

    act(() => showMenu!(42, 10, 20, false));
    expect(menuState).toMatchObject({ show: true, requestId: 42, x: 10, y: 20 });
    expect(cardRenders).toBe(1);
  });
});
