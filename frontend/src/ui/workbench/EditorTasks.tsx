import { useProjectOf, useWorkbench } from '../../logic/workbench/useWorkbench';
import type { ConnectionStatus, ProjectRecord } from '../../types';
import { Icon, Notice } from '../components/ui';
import { OutputCard } from './WorkbenchView';

interface Props {
  status: ConnectionStatus;
  path: string;
  dirty: boolean;
  /** The editor's conflict-checked save; false when nothing was saved. */
  save: () => Promise<boolean>;
  onOpenFile: (path: string, line: number, column: number | null) => void;
}

/**
 * The project's Workbench tasks in the editor, sharing the Workbench's state: a task runs the files
 * saved on ICF in the project's GPU session, so with unsaved edits it saves first (and stops if that
 * save does not happen). Shown only for files of a project that has tasks.
 */
export function EditorTasks(props: Props) {
  const project = useProjectOf(props.status, props.path);
  if (!project || !project.tasks?.length) return null;
  return <ProjectTasks {...props} project={project} />;
}

function ProjectTasks({ status, project, dirty, save, onOpenFile }: Props & { project: ProjectRecord }) {
  const w = useWorkbench(status, project);
  const s = w.session;
  const running = s.kind === 'running';
  const pick = (kind: string) => w.tasks.find((t) => t.kind === kind);
  const primary = [pick('build'), pick('test')].filter((t) => !!t);
  if (!primary.length) primary.push(w.tasks[0]!);
  const others = w.tasks.filter((t) => !primary.includes(t));
  const go = async (id: string) => {
    if (!id) return;
    if (dirty && !(await save())) return;
    await w.run(id);
  };
  const busy = (id: string) => !running || !!w.sending || !!w.activeRunOf(id);

  return (
    <>
      <div className="run-bar" role="toolbar" aria-label="Project tasks in the GPU session">
        <span className="muted small">Project tasks</span>
        {primary.map((t) => (
          <button
            key={t.id}
            className="btn small"
            disabled={busy(t.id)}
            onClick={() => void go(t.id)}
            title="Runs the files saved on ICF in the project's GPU session. Run on GPU uses an interactive kernel and the unsaved text instead."
          >
            <Icon name="play" size={12} /> {dirty ? `Save & ${t.name}` : t.name}
          </button>
        ))}
        {others.length > 0 && (
          <>
            <label className="sr-only" htmlFor="editor-more-tasks">
              Run another task
            </label>
            <select
              id="editor-more-tasks"
              value=""
              disabled={!running || !!w.sending}
              onChange={(e) => void go(e.target.value)}
            >
              <option value="">{dirty ? 'Save & run…' : 'More tasks…'}</option>
              {others.map((t) => (
                <option key={t.id} value={t.id} disabled={!!w.activeRunOf(t.id)}>
                  {t.name}
                </option>
              ))}
            </select>
          </>
        )}
        <span className="muted small">
          {s.kind === 'running'
            ? `GPU session: running on ${s.row.nodes ?? 'its node'}`
            : s.kind === 'pending'
              ? 'GPU session: waiting for a GPU'
              : 'No GPU session: start one in the project’s GPU Workbench'}
        </span>
      </div>
      {w.runError && <Notice tone="bad">{w.runError}</Notice>}
      {w.runs.length > 0 && <OutputCard w={w} onOpenFile={onOpenFile} compact />}
    </>
  );
}
