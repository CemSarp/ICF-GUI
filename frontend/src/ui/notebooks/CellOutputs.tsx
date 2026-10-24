import { useState } from 'react';
import { displayItem } from '../../logic/notebooks/outputs';
import type { Output } from '../../logic/notebooks/notebook';
import { Icon } from '../components/ui';
import { AnsiText, RichTree } from './RichTree';

function OutputView({ o }: { o: Output }) {
  const item = displayItem(o);
  if (!item) return null;
  switch (item.kind) {
    case 'image':
      return <img className="nb-img" alt={item.alt} src={item.src} />;
    case 'rich':
      return (
        <div className="nb-rich">
          <RichTree nodes={item.nodes} />
          {item.note && <p className="muted small">{item.note}</p>}
        </div>
      );
    case 'unsupported':
      return <p className="muted small nb-unsupported">Output not shown here ({item.mimes.join(', ')}).</p>;
    case 'text':
      return (
        <pre className={`nb-out${item.tone ? ` nb-${item.tone}` : ''}`}>
          <AnsiText segments={item.segments} />
          {item.hidden > 0 && <span className="muted">{`\n… ${item.hidden} more lines`}</span>}
        </pre>
      );
  }
}

/** A code cell's outputs, JupyterLab style: `[n]:` beside the result, collapsible as a whole. */
export function CellOutputs({ outputs, cell }: { outputs: Output[]; cell: number }) {
  const [collapsed, setCollapsed] = useState(false);
  if (outputs.length === 0) return null;
  return (
    <div className={`nb-outputs${collapsed ? ' collapsed' : ''}`} aria-label={`Cell ${cell} output`}>
      <button
        className="nb-collapse"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Show output' : 'Hide output'}
        title={collapsed ? 'Show output' : 'Hide output'}
        onClick={() => setCollapsed((c) => !c)}
      >
        <Icon name="chevron" size={12} />
      </button>
      {collapsed ? (
        <button className="nb-collapsed-note muted small" onClick={() => setCollapsed(false)}>
          {outputs.length} output{outputs.length === 1 ? '' : 's'} hidden
        </button>
      ) : (
        outputs.map((o, i) => (
          <div className="nb-output" key={i}>
            <span className="nb-prompt out" aria-hidden="true">
              {o.output_type === 'execute_result' ? `[${o.execution_count ?? ' '}]:` : ''}
            </span>
            <div className="nb-output-body">
              <OutputView o={o} />
            </div>
          </div>
        ))
      )}
    </div>
  );
}
