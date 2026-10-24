import { BackButton, Badge, Dialog, EmptyState, Icon, Notice } from '../components/ui';
import { errorMessage } from '../../logic/api';
import { formatTime } from '../../logic/format';
import { homePrefix, useEnvPanel } from '../../logic/projects/env';
import { useProjectDetail, useProjects } from '../../logic/projects/useProjects';
import { useVsCodeShare, useVsCodeStatus } from '../../logic/projects/vscode';
import type { ConnectionStatus, Interpreter, ProjectRecord } from '../../types';
import { RemoteBrowser } from './RemoteBrowser';

export interface ProjectNav {
  onStartTraining: (init: {
    projectDir: string;
    kind?: 'gpu_smoke_test';
    interpreter?: string | null;
    toolchainId?: string | null;
  }) => void;
  onUpload: (remoteDir: string) => void;
  onEditFile: (remotePath: string) => void;
}

export function ProjectsView({
  status,
  selected,
  onSelect,
  nav,
}: {
  status: ConnectionStatus;
  selected: string | null;
  onSelect: (path: string | null) => void;
  nav: ProjectNav;
}) {
  const { recent, error, project, open, forget } = useProjects(status, selected, onSelect);

  if (status.demo) {
    return (
      <EmptyState title="Projects need a live connection">
        Demo mode uses synthetic data. Connect to ICF to browse your remote home and open projects in VS Code.
      </EmptyState>
    );
  }

  if (selected && project) {
    return <ProjectDetail status={status} project={project} onBack={() => onSelect(null)} nav={nav} />;
  }

  return (
    <div className="projects">
      {error && <Notice tone="bad">{error}</Notice>}
      <section className="card" aria-labelledby="recent-title">
        <div className="card-head">
          <h2 id="recent-title">Recent projects</h2>
          {(recent.data?.length ?? 0) > 0 && (
            <button className="btn ghost" onClick={() => forget(null)}>
              Clear history
            </button>
          )}
        </div>
        {recent.error && <Notice tone="bad">{errorMessage(recent.error)}</Notice>}
        {recent.data && recent.data.length === 0 && (
          <p className="muted">No projects yet. Browse your ICF home below and choose a folder as a project.</p>
        )}
        {recent.data && recent.data.length > 0 && (
          <ul className="project-list">
            {recent.data.map((p) => (
              <li key={p.path}>
                <button className="project-tile" onClick={() => void open(p.path)}>
                  <span className="project-glyph">
                    <Icon name="folder" size={20} />
                  </span>
                  <span className="project-text">
                    <strong>{p.path.split('/').pop() || p.path}</strong>
                    <span className="mono muted">{p.path}</span>
                    <span className="muted small">
                      opened {formatTime(p.lastOpenedAt)}
                      {p.interpreter ? ` · ${p.interpreter}` : ' · no interpreter selected'}
                    </span>
                  </span>
                  <Icon name="forward" />
                </button>
                <button className="btn ghost small-btn" aria-label={`Forget ${p.path}`} onClick={() => forget(p.path)}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="muted small">Stored on this Mac only, per account. Never contains passwords.</p>
      </section>
      <RemoteBrowser
        status={status}
        start={null}
        allowMkdir
        onSelectDir={(p) => void open(p)}
        selectDirLabel="Open as project"
        title="Browse your ICF home"
      />
    </div>
  );
}

function ProjectDetail({
  status,
  project,
  onBack,
  nav,
}: {
  status: ConnectionStatus;
  project: ProjectRecord;
  onBack: () => void;
  nav: ProjectNav;
}) {
  const { launch, launchError, launching, openInVsCode, download, refresh } = useProjectDetail(status, project);

  return (
    <section aria-labelledby="project-title" className="project-detail">
      <BackButton label="All projects" onClick={onBack} />
      <div className="card-head">
        <h2 id="project-title" className="mono">
          {project.path}
        </h2>
        <div className="actions start">
          <button className="btn primary" onClick={() => void openInVsCode()} disabled={launching}>
            {launching ? 'Opening…' : 'Open in VS Code'}
          </button>
          <button
            className="btn"
            onClick={() =>
              nav.onStartTraining({
                projectDir: project.path,
                interpreter: project.interpreter,
                toolchainId: project.toolchainId,
              })
            }
          >
            New training workflow…
          </button>
        </div>
      </div>
      <Notice tone="warn" title="Editing is not GPU compute">
        VS Code's Run and Debug buttons execute on the login node (hastings), which has no GPU for you and must not run
        training. Selecting an interpreter does not allocate a GPU. Use <strong>New training workflow</strong> to run on
        a GPU through SLURM.
      </Notice>
      {launch && (
        <Notice tone="info" title="Launch requested">
          {launch.message}
        </Notice>
      )}
      {launchError && <Notice tone="bad">{launchError}</Notice>}
      <VsCodePanel status={status} />
      <EnvPanel
        project={project}
        onChanged={refresh}
        onSmokeTest={() =>
          nav.onStartTraining({
            projectDir: project.path,
            kind: 'gpu_smoke_test',
            interpreter: project.interpreter,
            toolchainId: project.toolchainId,
          })
        }
      />
      <RemoteBrowser
        status={status}
        start={project.path}
        allowMkdir
        title="Project files"
        onSelectDir={(p) => nav.onUpload(p)}
        selectDirLabel="Upload here…"
        fileAction={{ label: 'Download', run: (p) => void download(p) }}
        onOpenFile={nav.onEditFile}
      />
    </section>
  );
}

export function VsCodePanel({ status }: { status: ConnectionStatus }) {
  const { q, recheck, copied, copySnippet, openGuide } = useVsCodeStatus(status);
  const v = q.data;
  return (
    <section className="card" aria-labelledby="vscode-title">
      <div className="card-head">
        <h3 id="vscode-title">VS Code</h3>
        <button className="btn ghost" onClick={recheck} disabled={q.isFetching}>
          {q.isFetching ? 'Checking…' : 'Check again'}
        </button>
      </div>
      {q.error && <Notice tone="bad">{errorMessage(q.error)}</Notice>}
      {v && (
        <>
          <dl className="kv">
            <dt>VS Code</dt>
            <dd>{v.install ? `${v.install.version ?? 'installed'} · ${v.install.appPath}` : 'Not found'}</dd>
            <dt>Remote - SSH</dt>
            <dd>
              {v.install?.remoteSsh ? (
                <Badge tone="ok" glyph="✓">
                  {v.install.remoteSsh}
                </Badge>
              ) : (
                <Badge tone="bad" glyph="✕">
                  Not installed
                </Badge>
              )}
            </dd>
            <dt>Host for VS Code</dt>
            <dd className="mono">
              ssh-remote+{v.alias.alias} → {v.alias.user || '?'}@{v.alias.hostname}
              {v.alias.proxyJump ? ` via ${v.alias.proxyJump}` : v.alias.usesProxyCommand ? ' via ProxyCommand' : ''}
            </dd>
          </dl>
          <VsCodeShare status={status} />
          {v.problems.length === 0 ? (
            <p className="muted small">
              Ready. Without sharing, VS Code opens its own SSH connection with your ~/.ssh/config and may ask you to
              sign in again. The app never passes VS Code a password either way.
            </p>
          ) : (
            <Notice tone="warn" title="Before opening in VS Code">
              <ul>
                {v.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </Notice>
          )}
          {v.sshConfigSnippet && (
            <div>
              <pre className="code" aria-label="Suggested ~/.ssh/config block">
                {v.sshConfigSnippet}
              </pre>
              <div className="actions start">
                <button className="btn" onClick={copySnippet}>
                  {copied ? 'Copied' : 'Copy block'}
                </button>
                <button className="btn ghost" onClick={openGuide}>
                  Remote - SSH guide
                  <Icon name="external" size={14} />
                </button>
              </div>
              <p className="muted small">Paste it into ~/.ssh/config yourself; the app never edits that file.</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function statusBadge(i: Interpreter) {
  switch (i.status) {
    case 'ok':
      return (
        <Badge tone="ok" glyph="✓">
          Python {i.version}
        </Badge>
      );
    case 'missing':
      return <Badge tone="muted">Not found</Badge>;
    case 'not_executable':
      return (
        <Badge tone="bad" glyph="✕">
          Not executable
        </Badge>
      );
    default:
      return (
        <Badge tone="warn" glyph="!">
          Did not answer
        </Badge>
      );
  }
}

function EnvPanel({
  project,
  onChanged,
  onSmokeTest,
}: {
  project: ProjectRecord;
  onChanged: () => void;
  onSmokeTest: () => void;
}) {
  const {
    report,
    busy,
    error,
    extra,
    setExtra,
    preview,
    setPreview,
    applied,
    toolchains,
    tc,
    discover,
    save,
    previewSettings,
    apply,
    shown,
    noProjectEnv,
    info,
    torchCuda,
    rcStatus,
  } = useEnvPanel(project, onChanged);

  return (
    <section className="card" aria-labelledby="env-title">
      <div className="card-head">
        <h3 id="env-title">Python environment</h3>
        <button className="btn" onClick={() => void discover()} disabled={busy}>
          {busy ? 'Checking on ICF…' : report ? 'Check again' : 'Discover interpreters'}
        </button>
      </div>
      <p className="muted small">
        Checks <code>.venv</code>, <code>venv</code>, <code>env</code> in this project, interpreters you used before,
        system <code>python3</code> and any path you add — not a recursive search. Each runs <code>python -I -c</code>{' '}
        on the login node to read its version and installed package versions; nothing is imported and no GPU is touched.
      </p>
      <form
        className="input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void discover();
        }}
      >
        <label className="sr-only" htmlFor="extra-interp">
          Add interpreter path
        </label>
        <input
          id="extra-interp"
          className="mono"
          placeholder={`Add another, e.g. ${homePrefix(project.path)}/projects/icf-env/bin/python`}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          autoCapitalize="off"
          spellCheck={false}
        />
        <button className="btn" type="submit" disabled={busy || !extra.trim()}>
          Check this path
        </button>
      </form>
      {error && <Notice tone="bad">{error}</Notice>}
      {noProjectEnv && (
        <p className="muted small">
          No <code>.venv</code>, <code>venv</code> or <code>env</code> folder in this project; the interpreters below
          live elsewhere.
        </p>
      )}
      {report && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Interpreter</th>
                <th scope="col">Status</th>
                <th scope="col">Type</th>
                <th scope="col">PyTorch</th>
                <th scope="col">
                  <span className="sr-only">Select</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => (
                <tr key={i.path}>
                  <th scope="row" className="mono small">
                    {i.path}
                  </th>
                  <td>{statusBadge(i)}</td>
                  <td>{i.envType}</td>
                  <td className="small">
                    {i.torch ? `${i.torch}${i.torchCuda ? ` (CUDA ${i.torchCuda} build)` : ''}` : '—'}
                    {i.numpy && <span className="muted"> · numpy {i.numpy}</span>}
                    {i.nbconvert && <span className="muted"> · nbconvert</span>}
                  </td>
                  <td>
                    {i.status === 'ok' &&
                      (project.interpreter === i.path ? (
                        <Badge tone="ok" glyph="●">
                          Selected
                        </Badge>
                      ) : (
                        <button className="btn small-btn" onClick={() => void save({ interpreter: i.path })}>
                          Use
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <dl className="kv">
        <dt>Selected interpreter</dt>
        <dd className="mono">
          {project.interpreter ?? 'None'}
          {info && 'version' in info && info.version && <span className="muted"> · Python {info.version}</span>}
          {project.interpreterInfo && (
            <span className="muted small"> · last checked {formatTime(project.interpreterInfo.checkedAt)}</span>
          )}
        </dd>
        <dt>
          <label htmlFor="toolchain-select">CUDA toolchain</label>
        </dt>
        <dd>
          <select
            id="toolchain-select"
            value={project.toolchainId ?? ''}
            onChange={(e) => void save({ toolchainId: e.target.value || null })}
          >
            <option value="">None (virtualenv only)</option>
            {toolchains.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          {rcStatus && (
            <span className="small">
              {' '}
              {rcStatus === 'ok' ? (
                <Badge tone="ok" glyph="✓">
                  exists on ICF
                </Badge>
              ) : (
                <Badge tone="bad" glyph="✕">
                  {rcStatus} on ICF
                </Badge>
              )}
            </span>
          )}
          {tc?.note && <div className="muted small">{tc.note}</div>}
        </dd>
        <dt>GPU compatibility</dt>
        <dd>
          {torchCuda && tc?.cuda
            ? torchCuda === tc.cuda
              ? `PyTorch was built for CUDA ${torchCuda}, matching the toolchain. `
              : `PyTorch was built for CUDA ${torchCuda} but the toolchain provides CUDA ${tc.cuda}. `
            : ''}
          Only a job on a GPU node can confirm it — the login node has no GPU for you, so a false{' '}
          <code>torch.cuda.is_available()</code> there means nothing.{' '}
          <button className="link" onClick={onSmokeTest} disabled={!project.interpreter}>
            Run the GPU smoke test (short SLURM job)…
          </button>
        </dd>
      </dl>
      <div className="actions start">
        <button className="btn" onClick={() => void previewSettings()} disabled={!project.interpreter}>
          Set as VS Code interpreter…
        </button>
      </div>
      {applied && <Notice tone="ok">{applied}</Notice>}
      {preview && (
        <Dialog title="Update .vscode/settings.json?" onClose={() => setPreview(null)}>
          <p className="small">
            Sets <code>python.defaultInterpreterPath</code> in <code>{preview.file}</code>. All other settings are kept.
            {preview.exists &&
              ' The current file is backed up first, and the write is refused if it changed since this preview.'}
          </p>
          {preview.problem ? (
            <>
              <Notice tone="warn">{preview.problem}</Notice>
              <p className="small">You can add this to the file yourself in VS Code:</p>
              <pre className="code">{preview.manualSnippet}</pre>
            </>
          ) : (
            <div className="diff">
              <div>
                <h4>Now</h4>
                <pre className="code">{preview.before ?? '(file does not exist)'}</pre>
              </div>
              <div>
                <h4>After</h4>
                <pre className="code">{preview.after}</pre>
              </div>
            </div>
          )}
          <p className="muted small">This only affects VS Code's editor features. It does not allocate a GPU.</p>
          <div className="actions">
            <button className="btn" onClick={() => setPreview(null)} data-autofocus>
              Cancel
            </button>
            {preview.previewId && (
              <button className="btn primary" onClick={() => void apply()}>
                Write settings
              </button>
            )}
          </div>
        </Dialog>
      )}
    </section>
  );
}

/** "Sign VS Code in through this app": VS Code reuses the app's connection (ADR-028). */
function VsCodeShare({ status }: { status: ConnectionStatus }) {
  const { s, preview, setPreview, busy, error, toggle, turnOn } = useVsCodeShare(status);

  return (
    <div className="share">
      <label className="check">
        <input
          type="checkbox"
          checked={!!s?.enabled}
          disabled={!s || busy}
          onChange={(e) => toggle(e.target.checked)}
        />
        Sign VS Code in through this app (no password prompts)
      </label>
      <p className="muted small">
        VS Code reuses this app&apos;s signed-in connection, so neither the gateway nor ICF asks for your password. Your
        password never leaves the app. VS Code stays connected only while this app is connected, and the app does not
        disconnect for inactivity while VS Code uses it.
      </p>
      {s?.enabled && (
        <p className="small">
          {s.active ? (
            <Badge tone="ok" glyph="✓">
              VS Code reuses this connection ({s.alias})
            </Badge>
          ) : (
            <Badge tone="muted">On — takes effect while the app is connected</Badge>
          )}
        </p>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      {preview && (
        <Dialog title="Let VS Code reuse this connection?" labelledBy="share-title" onClose={() => setPreview(null)}>
          <p>Turning this on makes two local changes on this Mac. Nothing changes on ICF or in ~/.ssh/config.</p>
          <h4>1. A new ssh config file, used only by VS Code</h4>
          <p className="muted small mono">{preview.configFile}</p>
          <pre className="code">{preview.configText}</pre>
          <h4>2. One setting in VS Code&apos;s settings.json</h4>
          <p className="muted small mono">{preview.settingsFile}</p>
          <pre className="code">{preview.manualSnippet}</pre>
          {preview.problem ? (
            <Notice tone="warn" title="The app cannot edit this settings.json">
              {preview.problem}. Add the line above to it yourself in VS Code, then try again. Nothing was changed.
            </Notice>
          ) : (
            <p className="muted small">
              A backup of settings.json is kept next to it. Turning sharing off removes both.
            </p>
          )}
          <div className="actions">
            <button className="btn" onClick={() => setPreview(null)} data-autofocus>
              Cancel
            </button>
            <button className="btn primary" disabled={!preview.previewId || busy} onClick={turnOn}>
              Turn on
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
