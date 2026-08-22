import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImportRequestsDialog } from './ImportRequestsDialog';
import type { Request } from '../types';

// RequestsTable needs the channel context (PartyKit stores); the dialog chrome
// under test doesn't, so stub it out.
vi.mock('./RequestsTable', () => ({ RequestsTable: () => null }));

const request: Request = {
  id: 1,
  timestamp: new Date('2026-08-21T20:14:00Z'),
  donor: 'vip da mandy',
  amount: 'R$ 25,00',
  amountVal: 25,
  message: 'quero huntress',
  character: 'The Huntress',
  type: 'killer',
  source: 'donation',
};

function renderDialog(props: Partial<Parameters<typeof ImportRequestsDialog>[0]> = {}) {
  const onStop = vi.fn();
  const utils = render(
    <ImportRequestsDialog
      isOpen
      requests={[request]}
      isLoading
      onConfirm={vi.fn()}
      onClose={vi.fn()}
      onStop={onStop}
      {...props}
    />
  );
  return { onStop, ...utils };
}

const stopButton = () => screen.queryByRole('button', { name: /stop|parar/i });

describe('ImportRequestsDialog stop control', () => {
  it('interrupts the scan without closing the dialog', () => {
    const { onStop } = renderDialog();
    fireEvent.click(stopButton()!);
    expect(onStop).toHaveBeenCalledTimes(1);
    // Still open, with everything found so far listed.
    expect(screen.getByText(/recover requests|recuperar pedidos/i)).toBeTruthy();
  });

  it('shows the stop control only while scanning', () => {
    const { rerender } = renderDialog();
    expect(stopButton()).toBeTruthy();

    rerender(
      <ImportRequestsDialog
        isOpen
        requests={[request]}
        isLoading={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
        onStop={vi.fn()}
      />
    );
    expect(stopButton()).toBeNull();
  });

  it('omits the stop control when the scan cannot be interrupted', () => {
    renderDialog({ onStop: undefined });
    expect(stopButton()).toBeNull();
  });

  it('keeps the results selectable once the scan is stopped', () => {
    render(
      <ImportRequestsDialog
        isOpen
        requests={[request]}
        isLoading={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
        onStop={vi.fn()}
      />
    );
    const confirm = screen.getByRole('button', { name: /add|adicionar/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });
});
