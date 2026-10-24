import { isNotebook, useRecentNotebooks } from '../../logic/notebooks/recent';
import type { PageGuard } from '../../logic/app/guard';
import { formatTime } from '../../logic/format';
import type { ClusterSnapshot, ConnectionStatus } from '../../types';
import { EmptyState, Icon } from '../components/ui';
import { RemoteBrowser } from '../projects/RemoteBrowser';
import { NotebookPage } from './NotebookPage';
import '../../styles/notebook.css';

/** The Notebooks tab: the open notebook, or recent notebooks and a browser to open or create one. */
export function NotebooksView({
  status,
  snapshot,
  path,
  startDir,
  focus,
  onToggleFocus,
  onOpen,
  onClose,
  onGuard,
}: {
  status: ConnectionStatus;
  snapshot: ClusterSnapshot | null;
  path: string | null;
  startDir: string | null;
  focus: boolean;
  onToggleFocus: () => void;
  onOpen: (path: string) => void;
  onClose: () => void;
  onGuard: (g: PageGuard | null) => void;
}) {
  const { recent, forget } = useRecentNotebooks();
  if (path)
    return (
      <NotebookPage
        key={path}
        path={path}
        status={status}
        snapshot={snapshot}
        focus={focus}
        onToggleFocus={onToggleFocus}
        onClose={onClose}
        onGuard={onGuard}
      />
    );
  return (
    <div className="nb-landing">
      <section className="card" aria-labelledby="nb-recent">
        <div className="card-head">
          <h3 id="nb-recent">Recent notebooks</h3>
        </div>
        {recent.length === 0 ? (
          <EmptyState title="No notebooks yet">Open a notebook below, or create one with New file….</EmptyState>
        ) : (
          <ul className="nb-recent">
            {recent.map((r) => {
              const name = r.path.split('/').pop() ?? r.path;
              return (
                <li key={r.path}>
                  <button className="nb-recent-open" onClick={() => onOpen(r.path)}>
                    <span className="nb-recent-icon" aria-hidden="true">
                      <Icon name="notebook" size={18} />
                    </span>
                    <span className="nb-recent-text">
                      <strong>{name}</strong>
                      <span className="muted small mono">{r.path.slice(0, -name.length - 1)}</span>
                    </span>
                    <span className="muted small">{formatTime(new Date(r.openedAt).toISOString())}</span>
                  </button>
                  <button
                    className="btn ghost icon-btn small"
                    aria-label={`Remove ${name} from recent notebooks`}
                    onClick={() => forget(r.path)}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <RemoteBrowser
        status={status}
        start={startDir}
        title="Open a notebook on ICF"
        fileFilter={(e) => isNotebook(e.name)}
        onOpenFile={onOpen}
        newFileType="notebook"
      />
      <section className="card inset nb-about" aria-label="About interactive kernels">
        <h3>Interactive kernels</h3>
        <p className="muted small">
          Start a kernel from an open notebook to run cells one at a time on a GPU node of the Interactive partition,
          with variables kept between cells. The app asks SLURM for the allocation with <code>srun</code>, talks to the
          kernel over its own SSH connection (no ports or tokens), and releases the GPU when you stop the kernel, leave
          the notebook, disconnect, after 30 minutes without running a cell, or at the time limit. For long or
          unattended runs, use a batch notebook run (New job → Training workflow → Notebook).
        </p>
      </section>
    </div>
  );
}
