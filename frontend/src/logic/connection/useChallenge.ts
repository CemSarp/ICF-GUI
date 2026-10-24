import { useState } from 'react';
import { api } from '../api';
import type { Challenge } from '../../types';

/** Answer one SSH prompt. The typed value goes straight to the backend and is cleared from state. */
export function useChallenge(challenge: Challenge, onDone: (id: string) => void) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const answer = async (accept: boolean) => {
    setBusy(true);
    const v = value;
    setValue('');
    await api.answerChallenge(challenge.id, accept, accept ? v : undefined).catch(() => undefined);
    onDone(challenge.id);
  };

  return { value, setValue, busy, answer };
}
