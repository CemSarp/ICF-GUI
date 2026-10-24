import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { useNow } from '../persist';
import type { AuthMode, ConnectionProfile, ConnectionStatus } from '../../types';

/** Login form model: profiles, the fields sent to the backend, and the connect/forget/demo actions. */
export function useLogin(status: ConnectionStatus) {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [profile, setProfile] = useState<ConnectionProfile | null>(null);
  const [username, setUsername] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>('password');
  const [password, setPassword] = useState('');
  const [gatewayPassword, setGatewayPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [sameForBoth, setSameForBoth] = useState(false);
  const [alias, setAlias] = useState('icf');
  const [jumpHost, setJumpHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (ps: ConnectionProfile[], keep?: string) => {
    setProfiles(ps);
    const p = ps.find((x) => x.id === keep) ?? ps[0] ?? null;
    setProfile(p);
    if (p) {
      setUsername(p.username.toLowerCase());
      setAuthMode(p.authMode);
      setAlias(p.sshAlias);
      setJumpHost(p.jumpHost);
    }
  };
  useEffect(() => {
    api
      .profiles()
      .then((ps) => load(ps))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const connecting = busy || status.state === 'connecting' || status.state === 'auth_required';
  const saved = profile?.savedCredentials ?? [];
  const now = useNow(1000);
  const locked = status.lockedUntil !== null && new Date(status.lockedUntil).getTime() > now;

  const connect = async () => {
    if (!profile || connecting) return;
    setBusy(true);
    setError(null);
    // Hand secrets to the backend and drop them from UI state immediately.
    const pw = password;
    const gw = gatewayPassword;
    setPassword('');
    setGatewayPassword('');
    try {
      if (alias !== profile.sshAlias || jumpHost !== profile.jumpHost) {
        const updated = await api.saveProfile({
          ...profile,
          sshAlias: alias.trim(),
          jumpHost: jumpHost.trim(),
          username: username.trim(),
          authMode,
        });
        setProfile(updated);
      }
      await api.login({
        profileId: profile.id,
        username: username.trim(),
        authMode,
        password: authMode === 'password' && pw ? pw : undefined,
        gatewayPassword: authMode === 'password' && gw ? gw : undefined,
        sameForBoth: authMode === 'password' && sameForBoth,
        remember: authMode === 'password' && remember,
        useSaved: authMode === 'password' && saved.length > 0,
      });
    } catch (err) {
      setError(errorMessage(err));
      api
        .profiles()
        .then((ps) => load(ps, profile.id))
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!profile) return;
    try {
      const p = await api.forgetCredentials(profile.id);
      setProfile(p);
      setProfiles((ps) => ps.map((x) => (x.id === p.id ? p : x)));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const cancel = () => void api.cancel();
  const openDemo = () => void api.openDemo().catch((e) => setError(errorMessage(e)));
  const selectProfile = (id: string) => load(profiles, id);

  return {
    profiles,
    profile,
    selectProfile,
    username,
    setUsername,
    authMode,
    setAuthMode,
    password,
    setPassword,
    gatewayPassword,
    setGatewayPassword,
    remember,
    setRemember,
    sameForBoth,
    setSameForBoth,
    alias,
    setAlias,
    jumpHost,
    setJumpHost,
    error,
    connecting,
    saved,
    locked,
    connect,
    forget,
    cancel,
    openDemo,
  };
}
