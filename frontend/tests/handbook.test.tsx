import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCONNECTED } from '../src/logic/connection/useConnection';
import { HANDBOOK, filterSections, splitSections } from '../src/logic/handbook/handbook';
import { renderMarkdown } from '../src/logic/notebooks/markdown';
import { backend, connectedLive } from './mockBackend';
import { renderApp } from './render';

describe('Handbook text', () => {
  const { sections } = splitSections(HANDBOOK);

  it('numbered lists keep their numbers (a list from 1 has no start; one from 3 starts at 3)', () => {
    const ol = (md: string) =>
      renderMarkdown(md).find((n) => n.k === 'el' && n.tag === 'ol') as { attrs?: { start?: number } };
    expect(ol('1. a\n2. b').attrs?.start).toBeUndefined();
    expect(ol('3. a\n4. b').attrs?.start).toBe(3);
  });

  it('splits into titled sections with unique ids', () => {
    expect(sections.length).toBeGreaterThan(15);
    const ids = sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of sections) expect(s.title, s.body.slice(0, 40)).not.toBe('');
  });

  it('covers every screen, every job type and the MLS course', () => {
    const titles = sections.map((s) => s.title);
    for (const t of [
      'Sign-in screen',
      'Start',
      'Cluster',
      'Terminal',
      'New job',
      'Training workflow form',
      'My Jobs',
      'Projects',
      'Editor',
      'Notebooks',
      'Transfers',
      'Settings',
      'Handbook screen',
      'Recommended setup for the MLS course',
      'Troubleshooting',
    ])
      expect(titles, t).toContain(t);
    for (const tile of [
      'Python script',
      'Shell script',
      'Commands',
      'GPU session',
      'Notebook',
      'Managed training',
      'GPU test',
    ])
      expect(HANDBOOK, tile).toContain(`**${tile}**`);
  });

  it('search keeps only sections containing every word', () => {
    const hits = filterSections(sections, 'IDLE  gpu session');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(sections.length);
    expect(hits.every((s) => /idle/i.test(s.body) && /gpu/i.test(s.body) && /session/i.test(s.body))).toBe(true);
    expect(filterSections(sections, '')).toEqual(sections);
    expect(filterSections(sections, 'zzzz-nothing')).toEqual([]);
  });
});

describe('Handbook screen', () => {
  beforeEach(() => backend.reset(connectedLive));

  it('is in the sidebar, searchable, saves through the backend and copies everything', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Handbook' }));
    expect(await screen.findByRole('heading', { name: 'Recommended setup for the MLS course' })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Search the handbook'), 'zzzz-nothing');
    expect(screen.getByText(/Nothing in the handbook matches/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Search the handbook'));

    await userEvent.click(screen.getByRole('button', { name: 'Save as Markdown…' }));
    expect(await screen.findByText('Saved to /Users/me/Handbook.md.')).toBeInTheDocument();
    expect(backend.count('handbook_save')).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: 'Copy all' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(HANDBOOK));
  });

  it('opens from the sign-in screen before connecting', async () => {
    backend.reset(DISCONNECTED);
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Read the handbook' }));
    const contents = await screen.findByRole('navigation', { name: 'Handbook contents' });
    expect(within(contents).getByRole('button', { name: 'Sign-in screen' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Connect to ICF' })).toBeInTheDocument();
  });
});
