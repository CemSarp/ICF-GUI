import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Badge, EmptyState, Notice } from '../components/ui';
import { Nodes } from '../features/cluster/Nodes';
import { NodeDetail } from '../features/cluster/NodeDetail';
import { Overview } from '../features/cluster/Overview';
import { Partitions } from '../features/cluster/Partitions';
import { useSnapshot } from '../features/cluster/useSnapshot';
import { ChallengeDialog } from '../features/connection/ChallengeDialog';
import { LoginView } from '../features/connection/LoginView';
import { isLive, useConnection } from '../features/connection/useConnection';
import { JobDetailView } from '../features/jobs/JobDetailView';
import { MyJobsView } from '../features/jobs/MyJobsView';
import { RequestGpuView } from '../features/jobs/RequestGpuView';
import { SettingsView, type Theme } from '../features/settings/SettingsView';
import { api, errorMessage } from '../lib/api';
import { CONN_STATE, formatTime } from '../lib/format';
import { usePersistentState } from '../lib/persist';
import type { Settings } from '../types';

type View = 'overview' | 'partitions' | 'nodes' | 'request' | 'jobs' | 'settings';
const NAV: { id: View; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'partitions', label: 'Partitions' },
  { id: 'nodes', label: 'GPU Nodes' },
  { id: 'request', label: 'Request GPU' },
  { id: 'jobs', label: 'My Jobs' },
  { id: 'settings', label: 'Settings' },
];

export function App() {
  const { status, challenges, setChallenges } = useConnection();
  const [settings, setSettings] = useState<Settings>({ pollIntervalSecs: 60 });
  const [view, setView] = usePersistentState<View>('view', 'overview');
  const [theme, setTheme] = usePersistentState<Theme>('theme', 'system');
  const [partitionFilter, setPartitionFilter] = usePersistentState('nodes.partition', '');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [requestPartition, setRequestPartition] = useState<string | null>(null);
  const qc = useQueryClient();
  const live = isLive(status);
  const snap = useSnapshot(status, settings.pollIntervalSecs);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    api
      .settings()
      .then(setSettings)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    mainRef.current?.focus(); // move focus to content on navigation (screen readers)
  }, [view, selectedNode, selectedJob]);

  const go = (v: View) => {
    setSelectedNode(null);
    setSelectedJob(null);
    setRequestPartition(null);
    setView(v);
  };
  const snapshot = snap.data?.snapshot ?? null;
  const challenge = challenges[0];
  const dismissChallenge = (id: string) => setChallenges((q) => q.filter((c) => c.id !== id));

  if (!live) {
    return (
      <>
        <LoginView status={status} />
        {challenge && <ChallengeDialog key={challenge.id} challenge={challenge} onDone={dismissChallenge} />}
      </>
    );
  }

  const conn = CONN_STATE[status.state];
  const err = snap.data?.lastError ?? (snap.error ? { message: errorMessage(snap.error) } : null);

  return (
    <div className="shell">
      <a href="#main" className="skip">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          ICF Control Center
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.id}>
              <button className="nav" aria-current={view === n.id ? 'page' : undefined} onClick={() => go(n.id)}>
                {n.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot muted small">v0.2 · jobs need explicit confirmation</div>
      </nav>

      <div className="content">
        <header className="banner" aria-label="Connection">
          {status.demo && (
            <div className="demo-banner" role="status">
              DEMO MODE — synthetic data, not live ICF
            </div>
          )}
          <div className="banner-row">
            <Badge tone={conn.tone} glyph={conn.glyph}>
              {conn.label}
            </Badge>
            <span className="muted">
              {status.demo
                ? 'demo profile'
                : status.capabilities
                  ? `${status.capabilities.remoteUser}@${status.capabilities.remoteHost}`
                  : ''}
            </span>
            <span className="spacer" />
            {/* Jobs screens have their own refresh; one Refresh per screen avoids "which one?". */}
            {view !== 'jobs' && (
              <>
                <span aria-live="polite">
                  {snap.refreshing ? (
                    'Refreshing…'
                  ) : snapshot ? (
                    <>
                      Last updated {formatTime(snapshot.fetchedAt)}
                      {snapshot.stale && (
                        <>
                          {' '}
                          <Badge tone="warn" glyph="⚠">
                            Data stale
                          </Badge>
                        </>
                      )}
                      {snapshot.partial && (
                        <>
                          {' '}
                          <Badge tone="warn">Partial</Badge>
                        </>
                      )}
                    </>
                  ) : (
                    'No data yet'
                  )}
                </span>
                <button
                  className="btn"
                  onClick={snap.refreshNow}
                  disabled={snap.refreshDisabled}
                  title="Manual refresh (at most every 10 s)"
                >
                  Refresh
                </button>
              </>
            )}
            <button className="btn ghost" onClick={() => void api.disconnect().then(() => qc.clear())}>
              Disconnect
            </button>
          </div>
          {err && (
            <Notice tone="bad" title="Refresh failed">
              {err.message}
              {snap.data?.nextAllowedAt && ` Next automatic attempt after ${formatTime(snap.data.nextAllowedAt)}.`}
            </Notice>
          )}
        </header>

        <main id="main" tabIndex={-1} ref={mainRef} className="main">
          <h1 className="page-title">
            {selectedNode
              ? 'Node detail'
              : selectedJob
                ? 'Job detail'
                : view === 'request'
                  ? 'Request GPU / Submit Job'
                  : NAV.find((n) => n.id === view)?.label}
          </h1>
          {view === 'jobs' ? (
            selectedJob ? (
              <JobDetailView jobId={selectedJob} status={status} onBack={() => setSelectedJob(null)} />
            ) : (
              <MyJobsView status={status} onOpen={setSelectedJob} />
            )
          ) : view === 'settings' ? (
            <SettingsView
              settings={settings}
              onSettings={setSettings}
              theme={theme}
              setTheme={setTheme}
              status={status}
              snapshot={snap.data}
              onCacheCleared={() => qc.invalidateQueries({ queryKey: ['node'] })}
            />
          ) : snap.loading ? (
            <div className="skeleton" aria-busy="true">
              Loading cluster data…
            </div>
          ) : !snapshot ? (
            <EmptyState title="Data unavailable">
              {err ? 'The scheduler could not be queried. Try Refresh in a moment.' : 'No snapshot yet.'}
            </EmptyState>
          ) : view === 'request' ? (
            <RequestGpuView
              key={requestPartition ?? 'draft'}
              snapshot={snapshot}
              status={status}
              initialPartition={requestPartition}
              onOpenJobs={(jobId) => {
                go('jobs');
                if (jobId) setSelectedJob(jobId);
              }}
            />
          ) : selectedNode ? (
            <NodeDetail nodeId={selectedNode} version={snapshot.fetchedAtMs} onBack={() => setSelectedNode(null)} />
          ) : view === 'overview' ? (
            <Overview
              snapshot={snapshot}
              onOpenPartition={(p) => {
                setPartitionFilter(p);
                go('nodes');
              }}
            />
          ) : view === 'partitions' ? (
            <Partitions
              snapshot={snapshot}
              onOpenNodes={(p) => {
                setPartitionFilter(p);
                go('nodes');
              }}
              onRequest={(p) => {
                go('request');
                setRequestPartition(p);
              }}
            />
          ) : (
            <Nodes
              snapshot={snapshot}
              partitionFilter={partitionFilter}
              setPartitionFilter={setPartitionFilter}
              onSelect={setSelectedNode}
            />
          )}
          {snapshot && snapshot.warnings.length > 0 && ['overview', 'partitions', 'nodes'].includes(view) && (
            <details className="card small">
              <summary>{snapshot.warnings.length} data warning(s)</summary>
              <ul>
                {snapshot.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </main>
      </div>
      {challenge && <ChallengeDialog key={challenge.id} challenge={challenge} onDone={dismissChallenge} />}
    </div>
  );
}
