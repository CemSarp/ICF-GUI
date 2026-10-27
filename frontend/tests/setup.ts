import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Route every Tauri call to the in-memory mock backend (tests/mockBackend.ts).
vi.mock('@tauri-apps/api/core', async () => {
  const { backend } = await import('./mockBackend');
  return {
    // The kernel's event channel: the mock backend calls `onmessage` directly.
    Channel: class {
      onmessage: (m: unknown) => void = () => undefined;
    },
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

vi.mock('@tauri-apps/api/window', async () => {
  const { backend } = await import('./mockBackend');
  return {
    getCurrentWindow: () => ({
      setFullscreen: vi.fn(
        async (on: boolean) => void backend.calls.push({ cmd: 'window_set_fullscreen', args: { on } }),
      ),
    }),
  };
});

// jsdom has no layout: CodeMirror measures ranges when an editor takes focus.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

afterEach(() => {
  cleanup();
  localStorage.clear();
});
