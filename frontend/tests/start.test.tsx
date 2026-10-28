import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { backend, connectedLive } from './mockBackend';
import { renderApp } from './render';

describe('Start screen', () => {
  beforeEach(() => {
    backend.reset(connectedLive);
    localStorage.removeItem('icfcc.view'); // a first launch
  });

  it('opens first, says what to do next and counts milestones from local data only', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Run your code on an NVIDIA GPU' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start' })).toHaveAttribute('aria-current', 'page');
    // The mock has a recent project and a finished GPU test, but no accepted job yet.
    const next = await screen.findByRole('region', { name: 'Run your code on a GPU' });
    expect(within(next).getByText('Next step')).toBeInTheDocument();
    const list = screen.getByRole('region', { name: 'Your GPU milestones' });
    expect(within(list).getByText('Choose your project folder').closest('li')).toHaveClass('done');
    expect(within(list).getByText('Check that a GPU works').closest('li')).toHaveClass('done');
    expect(screen.getByLabelText(/milestones done/)).toBeInTheDocument();
    expect(screen.getByText('GeForce RTX 2080 Ti', { selector: 'strong' })).toBeInTheDocument();
    for (const cmd of ['jobs_submit', 'workflow_refresh', 'jobs_list_mine']) expect(backend.count(cmd)).toBe(0);
    await userEvent.click(within(next).getByRole('button', { name: 'Start a GPU job' }));
    expect(await screen.findByRole('heading', { name: 'New job' })).toBeInTheDocument();
  });

  it('remembers reading a log as a milestone', async () => {
    localStorage.setItem('icfcc.milestones', JSON.stringify({ log: 1 }));
    renderApp();
    const item = (await screen.findByText('Read the output', { selector: 'strong' })).closest('li')!;
    expect(item).toHaveClass('done');
  });
});
