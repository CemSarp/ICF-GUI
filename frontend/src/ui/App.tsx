import { lazy, Suspense, useEffect, useRef } from 'react';
import { Badge, Dialog, EmptyState, Icon, Notice, type IconName } from './components/ui';
import { Nodes } from './cluster/Nodes';
import { NodeDetail } from './cluster/NodeDetail';
import { Overview } from './cluster/Overview';
import { Partitions } from './cluster/Partitions';
import { ChallengeDialog } from './connection/ChallengeDialog';
import { LoginView } from './connection/LoginView';
import { JobDetailView } from './jobs/JobDetailView';
import { MyJobsView } from './jobs/MyJobsView';
import { NewJobView } from './jobs/NewJobView';
import { ProjectsView } from './projects/ProjectsView';
import { SettingsView } from './settings/SettingsView';
import { RunsView } from './training/RunsView';
import { TransfersView } from './transfers/TransfersView';
import { useAppShell, type View } from '../logic/app/useAppShell';
import { APP_VERSION } from '../logic/app/version';
import { CONN_STATE, formatTime } from '../logic/format';

// CodeMirror is only needed once a file is opened: keep it out of the startup bundle.
const EditorView = lazy(() => import('./editor/EditorView').then((m) => ({ default: m.EditorView })));
const NotebooksView = lazy(() => import('./notebooks/NotebooksView').then((m) => ({ default: m.NotebooksView })));

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
      // 'request' and 'training' keep their ids so saved navigation state stays valid.
      { id: 'request', label: 'New job', icon: 'request' },
      { id: 'jobs', label: 'My Jobs', icon: 'jobs' },
      { id: 'training', label: 'Runs', icon: 'training' },
    ],
  },
  {
    heading: 'Workspace',
    items: [
      { id: 'projects', label: 'Projects', icon: 'folder' },
      { id: 'notebooks', label: 'Notebooks', icon: 'notebook' },
      { id: 'transfers', label: 'Transfers', icon: 'transfers' },
    ],
  },
  { heading: '', items: [{ id: 'settings', label: 'Settings', icon: 'settings' }] },
];
const NAV = NAV_GROUPS.flatMap((g) => g.items);
/** Screens that use the cluster snapshot; only they show the snapshot's Refresh in the toolbar. */
const USES_SNAPSHOT: View[] = ['overview', 'partitions', 'nodes', 'request'];

export function App() {
  const {
    status,
    live,
    settings,
    setSettings,
    theme,
    setTheme,
    view,
    snap,
    snapshot,
    err,
    shareActive,
    vscodeInUse,
    challenge,
    dismissChallenge,
    partitionFilter,
    setPartitionFilter,
    selectedNode,
    setSelectedNode,
    selectedJob,
    setSelectedJob,
    requestPartition,
    project,
    setProject,
    jobMode,
    setJobMode,
    wizardInit,
    selectedRun,
    setSelectedRun,
    uploadDir,
    editingFile,
    setEditingFile,
    openNotebook,
    setOpenNotebook,
    guard,
    setGuard,
    focusMode,
    toggleFocus,
    openFile,
    pendingLeave,
    setPendingLeave,
    startTraining,
    navigate,
    requestDisconnect,
    confirmLeave,
    openNodes,
    requestOn,
    openJobs,
    openRun,
    uploadTo,
    onCacheCleared,
  } = useAppShell();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mainRef.current?.focus(); // move focus to content on navigation (screen readers)
  }, [view, selectedNode, selectedJob, project, selectedRun, editingFile, openNotebook]);

  if (!live) {
    return (
      <>
        <LoginView status={status} />
        {challenge && <ChallengeDialog key={challenge.id} challenge={challenge} onDone={dismissChallenge} />}
      </>
    );
  }

  const conn = CONN_STATE[status.state];

  return (
    <div className={focusMode && view === 'notebooks' ? 'shell focus' : 'shell'}>
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
                  <button
                    className="nav"
                    aria-current={view === n.id ? 'page' : undefined}
                    onClick={() => navigate(n.id)}
                  >
                    <Icon name={n.icon} />
                    {n.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="sidebar-foot muted small">Version {APP_VERSION}</div>
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
            {shareActive && (
              <Badge tone="info" glyph="⇄">
                Shared with VS Code
              </Badge>
            )}
            <button className="btn ghost" onClick={requestDisconnect}>
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
          <div
            className={view === 'notebooks' ? 'page wide' : 'page'}
            key={`${view}|${selectedNode ?? ''}|${selectedJob ?? ''}|${editingFile ?? ''}`}
          >
            <h1 className="page-title">{NAV.find((n) => n.id === view)?.label}</h1>
            {view === 'projects' && editingFile ? (
              <Suspense
                fallback={
                  <div className="skeleton" aria-busy="true">
                    Opening the editor…
                  </div>
                }
              >
                <EditorView
                  path={editingFile}
                  status={status}
                  snapshot={snapshot}
                  onClose={() => {
                    setGuard(null);
                    setEditingFile(null);
                  }}
                  onGuard={setGuard}
                />
              </Suspense>
            ) : view === 'projects' ? (
              <ProjectsView
                status={status}
                selected={project}
                onSelect={setProject}
                nav={{
                  onStartTraining: (init) => startTraining(init),
                  onUpload: uploadTo,
                  onEditFile: openFile,
                }}
              />
            ) : view === 'notebooks' ? (
              <Suspense
                fallback={
                  <div className="skeleton" aria-busy="true">
                    Opening Notebooks…
                  </div>
                }
              >
                <NotebooksView
                  status={status}
                  snapshot={snapshot}
                  path={openNotebook}
                  startDir={project}
                  focus={focusMode}
                  onToggleFocus={toggleFocus}
                  onOpen={setOpenNotebook}
                  onClose={() => {
                    setGuard(null);
                    if (focusMode) toggleFocus();
                    setOpenNotebook(null);
                  }}
                  onGuard={setGuard}
                />
              </Suspense>
            ) : view === 'training' ? (
              <RunsView
                status={status}
                selected={selectedRun}
                onSelect={setSelectedRun}
                onResume={(config) => startTraining({ config })}
              />
            ) : view === 'request' ? (
              <NewJobView
                mode={jobMode}
                setMode={setJobMode}
                status={status}
                snapshot={snapshot}
                snapshotLoading={snap.loading}
                requestPartition={requestPartition}
                wizardInit={wizardInit.init}
                wizardKey={wizardInit.key}
                onOpenJobs={openJobs}
                onOpenRun={openRun}
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
                onCacheCleared={onCacheCleared}
              />
            ) : snap.loading ? (
              <div className="skeleton" aria-busy="true">
                Loading cluster data…
              </div>
            ) : !snapshot ? (
              <EmptyState title="Data unavailable">
                {err ? 'The scheduler could not be queried. Try Refresh in a moment.' : 'No snapshot yet.'}
              </EmptyState>
            ) : selectedNode ? (
              <NodeDetail nodeId={selectedNode} version={snapshot.fetchedAtMs} onBack={() => setSelectedNode(null)} />
            ) : view === 'overview' ? (
              <Overview snapshot={snapshot} onOpenPartition={openNodes} />
            ) : view === 'partitions' ? (
              <Partitions snapshot={snapshot} onOpenNodes={openNodes} onRequest={requestOn} />
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
      {pendingLeave && (
        <Dialog
          title={
            pendingLeave === 'disconnect'
              ? 'Disconnect from ICF?'
              : guard?.dirty
                ? 'Discard unsaved changes?'
                : 'Stop the kernel?'
          }
          labelledBy="leave-title"
          onClose={() => setPendingLeave(null)}
        >
          {guard?.dirty && (
            <p>
              Your edits to <code>{guard.name}</code> have not been saved to ICF and will be lost.
            </p>
          )}
          {guard?.kernel && (
            <p>
              The kernel of <code>{guard.name}</code> stops and its GPU is released.
            </p>
          )}
          {pendingLeave === 'disconnect' && vscodeInUse && (
            <p>VS Code windows using this app&apos;s connection will disconnect too.</p>
          )}
          <div className="actions">
            <button className="btn" onClick={() => setPendingLeave(null)} data-autofocus>
              {guard?.dirty ? 'Keep editing' : guard ? 'Stay' : 'Stay connected'}
            </button>
            <button className="btn danger" onClick={confirmLeave}>
              {pendingLeave !== 'disconnect'
                ? guard?.dirty
                  ? 'Discard changes'
                  : 'Stop kernel and leave'
                : guard?.dirty
                  ? 'Discard and disconnect'
                  : 'Disconnect'}
            </button>
          </div>
        </Dialog>
      )}
      {challenge && <ChallengeDialog key={challenge.id} challenge={challenge} onDone={dismissChallenge} />}
    </div>
  );
}
