import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Route every Tauri call to the in-memory mock backend (tests/mockBackend.ts).
vi.mock('@tauri-apps/api/core', async () => {
  const { backend } = await import('./mockBackend');
  return {
    invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
      backend.calls.push({ cmd, args });
      const h = backend.handlers[cmd];
      if (!h) throw { code: 'INTERNAL', message: `unmocked ${cmd}` };
      return h(args);
    }),
  };
});

vi.mock('@tauri-apps/api/event', async () => {
  const { backend } = await import('./mockBackend');
  return {
    listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
      backend.listeners[name] = cb;
      return () => delete backend.listeners[name];
    }),
  };
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});
