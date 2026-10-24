import { SHORTCUTS } from '../../logic/notebooks/keys';
import { Dialog } from '../components/ui';

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Notebook shortcuts" labelledBy="shortcuts-title" onClose={onClose}>
      <p className="muted small">
        Press Esc to leave a cell’s editor; the letter keys then act on the selected cell, as in Jupyter.
      </p>
      <table className="shortcuts">
        <tbody>
          {SHORTCUTS.map(([k, what]) => (
            <tr key={k}>
              <th scope="row">
                <kbd>{k}</kbd>
              </th>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button className="btn primary" onClick={onClose} data-autofocus>
          Done
        </button>
      </div>
    </Dialog>
  );
}
