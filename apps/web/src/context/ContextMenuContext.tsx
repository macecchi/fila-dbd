import { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from 'react';

interface ContextMenuState {
  show: boolean;
  x: number;
  y: number;
  requestId: number | null;
  isDone: boolean;
}

interface ContextMenuActions {
  show: (id: number, x: number, y: number, isDone: boolean) => void;
  hide: () => void;
}

interface ContextMenuContextValue extends ContextMenuActions {
  state: ContextMenuState;
}

const initialState: ContextMenuState = {
  show: false,
  x: 0,
  y: 0,
  requestId: null,
  isDone: false
};

// Two contexts on purpose. Every request card needs `show`, but only the menu itself
// reads `state`. A single `{ state, show, hide }` value was a new object on every render
// of the list (i.e. every queue change), and a context change re-renders its consumers
// straight through `memo` — so each new request, ✓ or toast re-rendered all ~50 cards.
// The actions object is stable for the provider's lifetime.
const ContextMenuActionsContext = createContext<ContextMenuActions | null>(null);
const ContextMenuStateContext = createContext<ContextMenuState | null>(null);

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ContextMenuState>(initialState);

  const show = useCallback((id: number, x: number, y: number, isDone: boolean) => {
    setState({ show: true, x, y, requestId: id, isDone });
  }, []);

  const hide = useCallback(() => {
    setState(s => ({ ...s, show: false, requestId: null }));
  }, []);

  useEffect(() => {
    const handleClick = () => hide();
    const handleContext = (e: MouseEvent) => {
      if (!(e.target as Element).closest('.request-card')) hide();
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('contextmenu', handleContext);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('contextmenu', handleContext);
    };
  }, [hide]);

  const actions = useMemo(() => ({ show, hide }), [show, hide]);

  return (
    <ContextMenuActionsContext.Provider value={actions}>
      <ContextMenuStateContext.Provider value={state}>
        {children}
      </ContextMenuStateContext.Provider>
    </ContextMenuActionsContext.Provider>
  );
}

/** Stable `show`/`hide` — for the cards, which must not re-render when the menu opens. */
export function useContextMenuActions(): ContextMenuActions {
  const ctx = useContext(ContextMenuActionsContext);
  if (!ctx) throw new Error('useContextMenuActions must be used within ContextMenuProvider');
  return ctx;
}

export function useContextMenu(): ContextMenuContextValue {
  const actions = useContextMenuActions();
  const state = useContext(ContextMenuStateContext);
  if (!state) throw new Error('useContextMenu must be used within ContextMenuProvider');
  return { state, ...actions };
}
