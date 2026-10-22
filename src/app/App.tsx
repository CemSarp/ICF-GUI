import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Badge, EmptyState, Icon, Notice, type IconName } from '../components/ui';
import { Nodes } from '../features/cluster/Nodes';
import { NodeDetail } from '../features/cluster/NodeDetail';
import { Overview } from '../features/cluster/Overview';
import { Partitions } from '../features/cluster/Partitions';
import { useSnapshot } from '../features/cluster/useSnapshot';
import { ChallengeDialog } from '../features/connection/ChallengeDialog';
import { LoginView } from '../features/connection/LoginView';
import { isLive, useConnection } from '../features/connection/useConnection';
import { JobDetailView } from '../features/jobs/JobDetailView';
import { ProjectsView } from '../features/projects/ProjectsView';
import { TrainingView, type TrainingTab } from '../features/training/TrainingView';
import type { WizardInit } from '../features/training/TrainingWizard';
import { TransfersView } from '../features/transfers/TransfersView';
import { MyJobsView } from '../features/jobs/MyJobsView';
import { RequestGpuView } from '../features/jobs/RequestGpuView';
import { SettingsView, type Theme } from '../features/settings/SettingsView';
import { api, errorMessage } from '../lib/api';
import { CONN_STATE, formatTime } from '../lib/format';
import { usePersistentState } from '../lib/persist';
import type { Settings } from '../types';

type View =
  'overview' | 'partitions' | 'nodes' | 'request' | 'jobs' | 'projects' | 'training' | 'transfers' | 'settings';
type NavItem = { id: View; label: string; icon: IconName };
const NAV_GROUPS: { heading: string; items: NavItem[] }[] = [
  {
    heading: 'Cluster',
    items: [
      { id: 'overview', label: 'Overview', icon: 'overview' },
      { id: 'partitions', label: 'Partitions', icon: 'partitions' },
      { id: 'nodes', label: 'GPU Nodes', icon: 'nodes' },
    ],
  },
  {
    heading: 'Jobs',
    items: [
      { id: 'request', label: 'Request GPU', icon: 'request' },
      { id: 'jobs', label: 'My Jobs', icon: 'jobs' },
    ],
  },
  {
    heading: 'Workspace',
    items: [
      { id: 'projects', label: 'Projects', icon: 'folder' },
      { id: 'training', label: 'Training', icon: 'training' },
      { id: 'transfers', label: 'Transfers', icon: 'transfers' },
    ],
  },
  { heading: '', items: [{ id: 'settings', label: 'Settings', icon: 'settings' }] },
];
const NAV = NAV_GROUPS.flatMap((g) => g.items);
/** Screens that use the cluster snapshot; only they show the snapshot's Refresh in the toolbar. */
const USES_SNAPSHOT: View[] = ['overview', 'partitions', 'nodes', 'request'];

export function App() {
  const { status, challenges, setChallenges } = useConnection();
  const [settings, setSettings] = useState<Settings>({ pollIntervalSecs: 60 });
  const [view, setView] = usePersistentState<View>('view', 'overview');
  const [theme, setTheme] = usePersistentState<Theme>('theme', 'system');
  const [partitionFilter, setPartitionFilter] = usePersistentState('nodes.partition', '');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [requestPartition, setRequestPartition] = useState<string | null>(null);
  const [project, setProject] = usePersistentState<string | null>('project.selected', null);
  const [trainingTab, setTrainingTab] = usePersistentState<TrainingTab>('training.tab', 'new');
  const [wizardInit, setWizardInit] = useState<{ init: WizardInit | null; key: number }>({ init: null, key: 0 });
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [uploadDir, setUploadDir] = useState<string | null>(null);
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
  }, [view, selectedNode, selectedJob, project, selectedRun, trainingTab]);

  const go = (v: View) => {
    setSelectedNode(null);
    setSelectedJob(null);
    setRequestPartition(null);
    if (v !== 'training') setSelectedRun(null);
    setView(v);
  };
  const startTraining = (init: WizardInit) => {
    setWizardInit((w) => ({ init, key: w.key + 1 }));
    setTrainingTab('new');
    go('training');
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
          <span className="logo" aria-hidden="true">
            <Icon name="chip" size={16} />
          </span>
          ICF Control Center
        </div>
        {NAV_GROUPS.map((g) => (
          <div className={g.heading ? 'nav-group' : 'nav-group bottom'} key={g.heading}>
            {g.heading && (
              <div className="nav-heading" aria-hidden="true">
                {g.heading}
              </div>
            )}
            <ul>
              {g.items.map((n) => (
                <li key={n.id}>
                  <button className="nav" aria-current={view === n.id ? 'page' : undefined} onClick={() => go(n.id)}>
                    <Icon name={n.icon} />
                    {n.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="sidebar-foot muted small">Version 0.3.0</div>
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
            {/* Other screens have their own refresh (or none); one Refresh per screen avoids "which one?". */}
            {USES_SNAPSHOT.includes(view) && (
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
                  <Icon name="refresh" />
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
          <div className="page" key={`${view}|${selectedNode ?? ''}|${selectedJob ?? ''}`}>
            <h1 className="page-title">{NAV.find((n) => n.id === view)?.label}</h1>
            {view === 'projects' ? (
              <ProjectsView
                status={status}
                selected={project}
                onSelect={setProject}
                nav={{
                  onStartTraining: (init) => startTraining(init),
                  onUpload: (dir) => {
                    setUploadDir(dir);
                    go('transfers');
                  },
                }}
              />
            ) : view === 'training' ? (
              <TrainingView
                status={status}
                snapshot={snapshot}
                tab={trainingTab}
                setTab={setTrainingTab}
                init={wizardInit.init}
                wizardKey={wizardInit.key}
                selectedRun={selectedRun}
                onSelectRun={setSelectedRun}
                onResume={(config) => startTraining({ config })}
                onRefreshCluster={snap.refreshNow}
              />
            ) : view === 'transfers' ? (
              <TransfersView status={status} uploadDir={uploadDir ?? project} />
            ) : view === 'jobs' ? (
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
          </div>
        </main>
      </div>
      {challenge && <ChallengeDialog key={challenge.id} challenge={challenge} onDone={dismissChallenge} />}
    </div>
  );
}
