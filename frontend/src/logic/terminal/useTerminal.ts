import '@xterm/xterm/css/xterm.css';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import type { TerminalEvent } from '../../types';

export type TermStatus = 'starting' | 'live' | 'ended' | 'error';

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** ssh exits with 255 when the connection, not the shell, ended. */
const endText = (code: number | null) =>
  code === 255 ? 'connection lost' : code === 0 || code === null ? 'shell closed' : `shell exited with status ${code}`;

type Box = { term: Terminal | null; fit: FitAddon | null; id: string | null; connect: () => Promise<void> };

/**
 * The head node terminal (ADR-039): an xterm.js view of one login shell on ICF. The shell lives in
 * the backend, so the page can unmount and come back to it. xterm is loaded on first use.
 * Rendering uses WebGL because xterm's DOM renderer injects <style> elements, which the app's CSP
 * (`style-src 'self'`) does not allow.
 */
export function useTerminal(active: boolean) {
  const hostRef = useRef<HTMLDivElement>(null);
  const box = useRef<Box>({ term: null, fit: null, id: null, connect: async () => {} });
  const [status, setStatus] = useState<TermStatus>('starting');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const b = box.current;
    let cancelled = false;
    const fail = (e: unknown) => {
      if (cancelled) return;
      setStatus('error');
      setMessage(errorMessage(e));
    };
    const ro = new ResizeObserver(() => {
      if (host.offsetWidth > 0 && host.offsetHeight > 0) b.fit?.fit();
    });
    ro.observe(host);

    b.connect = async () => {
      const t = b.term;
      if (!t) return;
      setStatus('starting');
      setMessage('');
      try {
        b.fit?.fit();
        const r = await api.terminalOpen(t.cols, t.rows, (ev: TerminalEvent) => {
          if (cancelled) return;
          if (ev.event === 'data') t.write(bytes(ev.data));
          else {
            b.id = null;
            t.write(`\r\n\x1b[2m[${endText(ev.code)}]\x1b[0m\r\n`);
            setStatus('ended');
          }
        });
        if (cancelled) return;
        b.id = r.terminalId;
        setStatus('live');
        t.focus();
      } catch (e) {
        fail(e);
      }
    };

    void (async () => {
      try {
        const [{ Terminal }, { FitAddon }, { WebglAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-webgl'),
        ]);
        if (cancelled) return;
        const t = new Terminal({
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
          fontSize: 13,
          cursorBlink: true,
          scrollback: 5000,
          theme: { background: '#10131a', foreground: '#e6e8ee', cursor: '#e6e8ee' },
        });
        const fit = new FitAddon();
        t.loadAddon(fit);
        t.open(host);
        try {
          const gl = new WebglAddon();
          gl.onContextLoss(() => gl.dispose());
          t.loadAddon(gl);
        } catch {
          /* no WebGL: the DOM renderer still shows text, only unstyled under the app's CSP */
        }
        t.onData((d) => {
          if (b.id) api.terminalWrite(b.id, d).catch(() => {});
        });
        t.onResize(({ cols, rows }) => {
          if (b.id) api.terminalResize(b.id, cols, rows).catch(() => {});
        });
        b.term = t;
        b.fit = fit;
        await b.connect();
      } catch (e) {
        fail(e);
      }
    })();

    return () => {
      cancelled = true;
      ro.disconnect();
      b.term?.dispose();
      b.term = b.fit = b.id = null;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const b = box.current;
    const raf = requestAnimationFrame(() => {
      b.fit?.fit();
      b.term?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  /** Types text at the prompt without pressing Enter. */
  const insert = useCallback((text: string) => {
    const b = box.current;
    if (!b.id) return;
    api.terminalWrite(b.id, text).catch(() => {});
    b.term?.focus();
  }, []);

  /** After the shell ended: start a new one in the same view. */
  const restart = useCallback(() => {
    const b = box.current;
    b.term?.reset();
    void b.connect();
  }, []);

  return { hostRef, status, message, insert, restart };
}
