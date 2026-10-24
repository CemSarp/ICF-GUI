import { Dialog } from '../components/ui';

/** Save was refused because the file changed on ICF: keep editing, reload, or overwrite on purpose. */
export function ConflictDialog({
  name,
  busy,
  onCancel,
  onReload,
  onOverwrite,
}: {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onReload: () => void;
  onOverwrite: () => void;
}) {
  return (
    <Dialog title="The file changed on ICF" labelledBy="conflict-title" onClose={onCancel}>
      <p>
        <code>{name}</code> was changed on ICF after you opened it, for example in VS Code. Nothing was saved.
      </p>
      <div className="actions">
        <button className="btn" onClick={onCancel} data-autofocus>
          Cancel
        </button>
        <button className="btn" onClick={onReload}>
          Reload from ICF (discard my edits)
        </button>
        <button className="btn danger" onClick={onOverwrite} disabled={busy}>
          Overwrite the version on ICF
        </button>
      </div>
    </Dialog>
  );
}
