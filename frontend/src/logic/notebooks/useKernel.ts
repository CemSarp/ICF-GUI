import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import type { KernelEvent, NotebookOutput } from '../../types';

export type KernelState =
  | { phase: 'off' }
  | { phase: 'starting' }
  | { phase: 'queued'; jobId: string }
  | { phase: 'ready'; jobId: string; node: string; python: string; tools: string; endsAtMs: number; busy: boolean }
  | { phase: 'ended'; reason: string; message: string };

/** Where the live results of one execution go (one code cell). */
export interface ExecSink {
  /** The kernel is now running this request (earlier ones finished); never called inside exec(). */
  started(): void;
  output(o: NotebookOutput): void;
  clear(wait: boolean): void;
  done(count: number | null, status: 'ok' | 'error' | 'aborted'): void;
}

let seq = 0;
const requestId = () => `r${Date.now().toString(36)}-${(seq++).toString(36)}`;

export const kernelActive = (s: KernelState) => s.phase === 'starting' || s.phase === 'queued' || s.phase === 'ready';

/**
 * The notebook page's kernel (ADR-031). It lives exactly as long as the page: unmounting stops it,
 * and mounting stops any kernel a reloaded page left behind. Cells run in order; while the kernel
 * is still starting their requests wait here and are sent once it is ready.
 */
export function useKernel() {
  const [state, setState] = useState<KernelState>({ phase: 'off' });
  const [error, setError] = useState<string | null>(null);
  const id = useRef<string | null>(null);
  const phase = useRef<KernelState['phase']>('off');
  /** Sent to the kernel, in order: the head is the one running. */
  const queue = useRef<{ rid: string; sink: ExecSink }[]>([]);
  /** Waiting for the kernel to become ready. */
  const held = useRef<{ rid: string; code: string; sink: ExecSink }[]>([]);

  const set = (s: KernelState) => {
    phase.current = s.phase;
    setState(s);
  };
  const sinkOf = (rid: string) => queue.current.find((q) => q.rid === rid)?.sink;
  const abortAll = () => {
    for (const q of [...queue.current, ...held.current]) q.sink.done(null, 'aborted');
    queue.current = [];
    held.current = [];
  };
  const send = (rid: string, code: string, sink: ExecSink) => {
    const k = id.current;
    if (!k) return sink.done(null, 'aborted');
    queue.current.push({ rid, sink });
    // Deferred: callers mark the run as queued right after exec() returns.
    if (queue.current.length === 1) queueMicrotask(() => sink.started());
    api.kernelExecute(k, rid, code).catch((e) => {
      queue.current = queue.current.filter((q) => q.rid !== rid);
      sink.done(null, 'aborted');
      setError(errorMessage(e));
    });
  };

  const onEvent = (e: KernelEvent) => {
    switch (e.event) {
      case 'starting':
        if (phase.current === 'starting' || phase.current === 'off') set({ phase: 'starting' });
        break;
      case 'queued':
        set({ phase: 'queued', jobId: e.jobId });
        break;
      case 'ready': {
        set({
          phase: 'ready',
          jobId: e.jobId,
          node: e.node,
          python: e.python,
          tools: e.tools,
          endsAtMs: e.endsAtMs,
          busy: false,
        });
        const waiting = held.current;
        held.current = [];
        for (const h of waiting) send(h.rid, h.code, h.sink);
        break;
      }
      case 'status':
        setState((s) => (s.phase === 'ready' ? { ...s, busy: e.busy } : s));
        break;
      case 'output':
        sinkOf(e.id)?.output(e.output);
        break;
      case 'clear':
        sinkOf(e.id)?.clear(e.wait);
        break;
      case 'done': {
        const i = queue.current.findIndex((q) => q.rid === e.id);
        if (i < 0) break;
        const [q] = queue.current.splice(i, 1);
        q!.sink.done(e.count, e.status);
        queue.current[0]?.sink.started();
        break;
      }
      case 'restarted':
        abortAll();
        setState((s) => (s.phase === 'ready' ? { ...s, busy: false } : s));
        break;
      case 'ended':
        abortAll();
        id.current = null;
        set({ phase: 'ended', reason: e.reason, message: e.message });
        break;
    }
  };

  const start = async (previewId: string) => {
    setError(null);
    set({ phase: 'starting' });
    try {
      const r = await api.kernelStart(previewId, true, onEvent);
      if (phase.current !== 'ended') id.current = r.kernelId;
    } catch (e) {
      set({ phase: 'off' });
      setError(errorMessage(e));
    }
  };
  /** Run `code`; false when no kernel is running or starting (the caller offers to start one). */
  const exec = (code: string, sink: ExecSink) => {
    const rid = requestId();
    if (phase.current === 'ready') send(rid, code, sink);
    else if (phase.current === 'starting' || phase.current === 'queued') held.current.push({ rid, code, sink });
    else return false;
    return true;
  };
  const call = (f: (k: string) => Promise<unknown>) => {
    const k = id.current;
    if (k) f(k).catch((e) => setError(errorMessage(e)));
  };
  const interrupt = () => call(api.kernelInterrupt);
  const restart = () => call(api.kernelRestart);
  const stop = async () => {
    held.current.forEach((h) => h.sink.done(null, 'aborted'));
    held.current = [];
    await api.kernelStop(id.current).catch((e) => setError(errorMessage(e)));
  };

  useEffect(() => {
    void api.kernelStop(null).catch(() => undefined);
    return () => {
      if (phase.current !== 'off' && phase.current !== 'ended') void api.kernelStop(id.current).catch(() => undefined);
    };
  }, []);

  return { state, error, setError, start, exec, interrupt, restart, stop, active: kernelActive(state) };
}

export type Kernel = ReturnType<typeof useKernel>;
