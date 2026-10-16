import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { DISCONNECTED } from '../src/features/connection/useConnection';
import type { Challenge } from '../src/types';
import { backend, profile } from './mockBackend';
import { renderApp } from './render';

const challenge = (c: Partial<Challenge>): Challenge => ({
  id: 'c1',
  kind: 'password',
  hopLabel: 'gateway',
  user: 's1234567',
  host: 'student.ssh.inf.ed.ac.uk',
  keyType: null,
  fingerprint: null,
  text: '',
  secretInput: true,
  note: null,
  ...c,
});

describe('login (V1-AC01, V1-AC03)', () => {
  beforeEach(() => backend.reset(DISCONNECTED));

  it('offers the required controls with Remember OFF by default', async () => {
    renderApp();
    expect(await screen.findByRole('heading', { name: 'Connect to ICF' })).toBeInTheDocument();
    expect(screen.getByLabelText('Remember password in macOS Keychain')).not.toBeChecked();
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(/Use existing SSH config/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('sends the password once and clears it from the form', async () => {
    renderApp();
    const pw = await screen.findByLabelText('Password');
    await userEvent.type(pw, 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(backend.count('connection_test_and_login')).toBe(1));
    const req = backend.calls.find((c) => c.cmd === 'connection_test_and_login')!.args.request as Record<
      string,
      unknown
    >;
    expect(req).toMatchObject({ password: 'hunter2', remember: false, sameForBoth: false, authMode: 'password' });
    expect(pw).toHaveValue('');
    expect(document.body.innerHTML).not.toContain('hunter2');
  });

  it('agent mode never sends a password', async () => {
    renderApp();
    await userEvent.click(await screen.findByLabelText(/Use existing SSH config/));
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(backend.count('connection_test_and_login')).toBe(1));
    const req = backend.calls.find((c) => c.cmd === 'connection_test_and_login')!.args.request as Record<
      string,
      unknown
    >;
    expect(req.password).toBeUndefined();
    expect(req.remember).toBe(false);
  });

  it('shows backend errors (e.g. changed host key) and does not retry', async () => {
    backend.reset(DISCONNECTED, {
      connection_test_and_login: () => {
        throw { code: 'SSH_HOST_KEY', message: "The server's host key has CHANGED. Connection blocked." };
      },
    });
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/host key has CHANGED/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.count('connection_test_and_login')).toBe(1);
  });

  it('pauses sign-in after repeated failures', async () => {
    backend.reset({
      ...DISCONNECTED,
      state: 'auth_failed',
      failedAttempts: 3,
      lockedUntil: new Date(Date.now() + 300_000).toISOString(),
    });
    renderApp();
    expect(await screen.findByText('Sign-in paused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('host-key prompt shows the fingerprint and can be rejected', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'Connect to ICF' });
    act(() =>
      backend.emit(
        'auth-challenge',
        challenge({
          kind: 'host_key',
          host: 'icf',
          keyType: 'ED25519',
          fingerprint: 'SHA256:abc123',
          secretInput: false,
        }),
      ),
    );
    expect(await screen.findByRole('dialog', { name: 'Verify host key' })).toBeInTheDocument();
    expect(screen.getByText('SHA256:abc123')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject and stop' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Reject and stop' }));
    const a = backend.calls.find((c) => c.cmd === 'connection_answer_challenge')!.args;
    expect(a).toMatchObject({ id: 'c1', accept: false, response: null });
  });

  it('password prompt for a hop is answered and cleared; Escape denies', async () => {
    renderApp();
    await screen.findByRole('heading', { name: 'Connect to ICF' });
    act(() => backend.emit('auth-challenge', challenge({})));
    expect(await screen.findByText('s1234567@student.ssh.inf.ed.ac.uk')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Response'), 'gatewaypw{Enter}');
    await waitFor(() => expect(backend.count('connection_answer_challenge')).toBe(1));
    expect(backend.calls.at(-1)!.args).toMatchObject({ accept: true, response: 'gatewaypw' });
    act(() =>
      backend.emit('auth-challenge', challenge({ id: 'c2', kind: 'other', text: '(s1@icf) Verification code:' })),
    );
    await screen.findByText('(s1@icf) Verification code:');
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(backend.count('connection_answer_challenge', (a) => a.id === 'c2' && a.accept === false)).toBe(1),
    );
  });

  it('forgetting a saved password requires confirmation', async () => {
    backend.reset(DISCONNECTED, {
      connection_profiles_list: () => [{ ...profile, savedCredentials: ['s1234567@icf'] }],
    });
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Forget saved password' }));
    expect(backend.count('connection_forget_credentials')).toBe(0);
    expect(screen.getByRole('dialog', { name: 'Forget saved password?' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete from Keychain' }));
    await waitFor(() => expect(backend.count('connection_forget_credentials', (a) => a.confirm === true)).toBe(1));
    await waitFor(() => expect(screen.queryByText(/Saved in Keychain/)).not.toBeInTheDocument());
  });

  it('uses a saved password when the field is left empty', async () => {
    backend.reset(DISCONNECTED, {
      connection_profiles_list: () => [{ ...profile, savedCredentials: ['s1234567@icf'] }],
    });
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(backend.count('connection_test_and_login')).toBe(1));
    const req = backend.calls.find((c) => c.cmd === 'connection_test_and_login')!.args.request as Record<
      string,
      unknown
    >;
    expect(req).toMatchObject({ useSaved: true, password: undefined });
  });
});
