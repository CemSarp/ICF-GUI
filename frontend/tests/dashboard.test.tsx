import { focusManager } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectedDemo, backend, snapshot } from './mockBackend';
import { renderApp } from './render';

describe('dashboard (V1-AC04..AC09)', () => {
  beforeEach(() => backend.reset(connectedDemo));
  afterEach(() => {
    vi.useRealTimers();
    focusManager.setFocused(undefined);
  });

  it('labels demo data and lists every visible partition', async () => {
    renderApp();
    expect(await screen.findByText(/DEMO MODE — synthetic data, not live ICF/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Partitions' }));
    for (const p of ['Interactive', 'Teaching', 'ICF-Free', 'ICF-Research', 'Open-Research']) {
      expect(screen.getByRole('heading', { name: p })).toBeInTheDocument();
    }
    expect(screen.getByText(/Visibility does not imply eligibility/)).toBeInTheDocument();
  });

  it('shows Unknown rather than 0 when allocation cannot be determined', async () => {
    renderApp();
    await screen.findByText(/DEMO MODE/);
    await userEvent.click(screen.getByRole('button', { name: 'GPU Nodes' }));
    const row = screen.getByRole('button', { name: 'landonia21' }).closest('tr')!;
    expect(within(row).getByText(/allocation unknown/)).toBeInTheDocument();
    expect(within(row).getByText('Unknown')).toBeInTheDocument();
  });

  it('node detail shows MIG slices distinct from physical GPUs', async () => {
    renderApp();
    await screen.findByText(/DEMO MODE/);
    await userEvent.click(screen.getByRole('button', { name: 'GPU Nodes' }));
    await userEvent.click(screen.getByRole('button', { name: 'saxa' }));
    expect(await screen.findByRole('heading', { name: 'Node saxa' })).toBeInTheDocument();
    expect(screen.getByText('H200 3g.71gb')).toBeInTheDocument();
    expect(screen.getByText('MIG slice')).toBeInTheDocument();
    expect(screen.getByText('Physical')).toBeInTheDocument();
  });

  it('coalesces rapid manual refresh clicks', async () => {
    renderApp();
    await screen.findByText(/DEMO MODE/);
    const btn = screen.getByRole('button', { name: 'Refresh' });
    for (let i = 0; i < 10; i++) await userEvent.click(btn);
    await waitFor(() => expect(backend.count('cluster_get_snapshot', (a) => a.forceRefresh === true)).toBe(1));
    expect(btn).toBeDisabled();
  });

  it('polls on the interval only while visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderApp();
    await screen.findByText(/DEMO MODE/);
    const scheduled = () => backend.count('cluster_get_snapshot', (a) => a.forceRefresh === false);
    // The banner commits before React Query's subscribe effect starts the first fetch.
    await waitFor(() => expect(scheduled()).toBe(1));
    await act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(scheduled()).toBe(2);
    act(() => focusManager.setFocused(false)); // window hidden / minimised
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(scheduled()).toBe(2);
  });

  it('stops polling and returns to login when authentication fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderApp();
    await screen.findByText(/DEMO MODE/);
    act(() => backend.emit('connection-status', { ...connectedDemo, demo: false, state: 'auth_failed' }));
    expect(await screen.findByRole('heading', { name: 'Connect to ICF' })).toBeInTheDocument();
    const before = backend.count('cluster_get_snapshot');
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(backend.count('cluster_get_snapshot')).toBe(before);
  });

  it('shows stale data and the refresh error distinctly', async () => {
    backend.reset(connectedDemo, {
      cluster_get_snapshot: () => ({
        snapshot: { ...snapshot, stale: true },
        lastError: { code: 'SLURM_UNAVAILABLE', message: 'The SLURM controller did not answer.' },
        lastAttemptAt: snapshot.fetchedAt,
        nextAllowedAt: null,
        fetched: true,
        inventoryRequests: 1,
      }),
    });
    renderApp();
    expect(await screen.findByText('Data stale')).toBeInTheDocument();
    expect(screen.getByText('Refresh failed')).toBeInTheDocument();
    expect(screen.getByText(/did not answer/)).toBeInTheDocument();
  });

  it('distinguishes data unavailable from empty and filtered states', async () => {
    backend.reset(connectedDemo, {
      cluster_get_snapshot: () => ({
        snapshot: null,
        lastError: { code: 'NOT_CONNECTED', message: 'The SSH session has ended.' },
        lastAttemptAt: null,
        nextAllowedAt: null,
        fetched: true,
        inventoryRequests: 1,
      }),
    });
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Data unavailable' })).toBeInTheDocument();

    backend.reset(connectedDemo);
    const { unmount } = renderApp();
    await screen.findAllByText(/DEMO MODE/);
    unmount();
  });

  it('filters nodes locally without network calls', async () => {
    renderApp();
    await screen.findByText(/DEMO MODE/);
    await userEvent.click(screen.getByRole('button', { name: 'GPU Nodes' }));
    const calls = backend.calls.length;
    await userEvent.type(screen.getByLabelText('Search'), 'zzz-nothing');
    expect(screen.getByRole('heading', { name: 'Filtered out' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('button', { name: 'landonia11' })).toBeInTheDocument();
    expect(backend.calls.length).toBe(calls);
  });

  it('counts a node in two partitions once in fleet totals', async () => {
    renderApp();
    await screen.findByText(/DEMO MODE/);
    const ti = snapshot.gpuTotals.find((t) => t.gresName === 'gpu:nvidia_geforce_rtx_2080_ti')!;
    const partitionSum = snapshot.partitions
      .flatMap((p) => p.gpuTotals)
      .filter((t) => t.gresName === ti.gresName)
      .reduce((a, t) => a + t.configured, 0);
    expect(partitionSum).toBeGreaterThan(ti.configured);
    expect(
      await screen.findByRole('img', { name: new RegExp(`RTX 2080 Ti: ${ti.configured} configured`) }),
    ).toBeInTheDocument();
  });
});
