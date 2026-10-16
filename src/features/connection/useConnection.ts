import { useEffect, useState } from 'react';
import { api, events } from '../../lib/api';
import type { Challenge, ConnectionStatus } from '../../types';

export const DISCONNECTED: ConnectionStatus = {
  state: 'disconnected',
  profileId: null,
  demo: false,
  capabilities: null,
  hops: [],
  connectedAt: null,
  error: null,
  failedAttempts: 0,
  lockedUntil: null,
};

/** Backend-authoritative connection status plus the queue of pending SSH prompts. */
export function useConnection() {
  const [status, setStatus] = useState<ConnectionStatus>(DISCONNECTED);
  const [challenges, setChallenges] = useState<Challenge[]>([]);

  useEffect(() => {
    let alive = true;
    const unlisten = [
      events.onStatus((s) => alive && setStatus(s)),
      events.onChallenge((c) => alive && setChallenges((q) => [...q.filter((x) => x.id !== c.id), c])),
      events.onChallengeClosed((id) => alive && setChallenges((q) => q.filter((x) => x.id !== id))),
    ];
    api
      .status()
      .then((s) => alive && setStatus(s))
      .catch(() => undefined);
    return () => {
      alive = false;
      unlisten.forEach((p) => p.then((f) => f()).catch(() => undefined));
    };
  }, []);

  return { status, setStatus, challenges, setChallenges };
}

export const isLive = (s: ConnectionStatus) => s.state === 'connected' || s.state === 'degraded';
