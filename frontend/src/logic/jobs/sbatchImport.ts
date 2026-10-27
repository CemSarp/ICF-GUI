/** Form values read from a batch file's `#SBATCH` lines (only those the file sets). */
export interface SbatchSettings {
  partition?: string;
  /** `gpu:<type>` when the file names a GPU type. */
  gres?: string;
  gpuCount?: number;
  cpus?: number;
  memoryGb?: number;
  hours?: number;
  minutes?: number;
  jobName?: string;
}

export interface SbatchImport {
  settings: SbatchSettings;
  /** The file's commands without the shebang, `#SBATCH` lines and `cd "$SLURM_SUBMIT_DIR"`. */
  commands: string;
  /** What was not taken over, in plain words. */
  notes: string[];
}

/** SLURM time: `M`, `M:S`, `H:M:S`, `D-H`, `D-H:M`, `D-H:M:S` → hours and minutes (seconds round up). */
export function parseTime(t: string): { hours: number; minutes: number } | null {
  const m = /^(?:(\d+)-)?(\d+)(?::(\d+))?(?::(\d+))?$/.exec(t.trim());
  if (!m) return null;
  const [, d, a, b, c] = m;
  const n = (x?: string) => (x === undefined ? 0 : parseInt(x, 10));
  let secs: number;
  if (d !== undefined) secs = n(d) * 86400 + n(a) * 3600 + n(b) * 60 + n(c);
  else if (c !== undefined) secs = n(a) * 3600 + n(b) * 60 + n(c);
  else if (b !== undefined) secs = n(a) * 60 + n(b);
  else secs = n(a) * 60;
  const mins = Math.ceil(secs / 60);
  return { hours: Math.floor(mins / 60), minutes: mins % 60 };
}

/** `16G`, `16000M`, `16000` (MB) → GB, rounded up. */
function parseMem(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([KMGT]?)B?$/i.exec(v.trim());
  if (!m) return null;
  const mb =
    parseFloat(m[1]!) *
    ({ K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024, '': 1 } as const)[m[2]!.toUpperCase() as 'K' | 'M' | 'G' | 'T' | ''];
  return Math.max(1, Math.ceil(mb / 1024));
}

const SUBMIT_DIR_CD = /^\s*cd\s+"?\$\{?SLURM_SUBMIT_DIR\}?"?\s*(?:\|\|.*)?$/;

/**
 * Reads a batch file such as a course's `run_asr.sbatch`: its `#SBATCH` resources become form values
 * and the rest becomes the commands. `null` when the file has no `#SBATCH` line.
 */
export function parseSbatch(text: string): SbatchImport | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (!lines.some((l) => /^#SBATCH\s/.test(l))) return null;
  const settings: SbatchSettings = {};
  const notes: string[] = [];
  const body: string[] = [];
  let header = true; // SLURM reads #SBATCH lines only before the first command
  lines.forEach((line, i) => {
    if (i === 0 && line.startsWith('#!')) return;
    const opt = /^#SBATCH\s+(.*)$/.exec(line);
    if (opt && header) {
      const [flag, inline] = opt[1]!.trim().split(/[=\s]+/, 2) as [string, string | undefined];
      const value = (inline ?? '').replace(/^["']|["']$/g, '');
      switch (flag) {
        case '-p':
        case '--partition':
          settings.partition = value;
          break;
        case '--gres': {
          const g = /^gpu(?::([\w.-]+))?(?::(\d+))?$/.exec(value);
          if (g) {
            if (g[1] && !/^\d+$/.test(g[1])) settings.gres = `gpu:${g[1]}`;
            settings.gpuCount = parseInt(g[2] ?? (g[1] && /^\d+$/.test(g[1]) ? g[1] : '1'), 10);
          } else notes.push(`--gres=${value} was not understood; choose the GPU below.`);
          break;
        }
        case '-c':
        case '--cpus-per-task':
          settings.cpus = parseInt(value, 10) || undefined;
          break;
        case '--mem': {
          const gb = parseMem(value);
          if (gb) settings.memoryGb = gb;
          break;
        }
        case '-t':
        case '--time': {
          const t = parseTime(value);
          if (t) Object.assign(settings, t);
          break;
        }
        case '-J':
        case '--job-name':
          if (/^[A-Za-z0-9][\w.-]{0,63}$/.test(value)) settings.jobName = value;
          break;
        case '-o':
        case '--output':
        case '-e':
        case '--error':
          notes.push(`Its ${flag} is not used: the output goes to slurm-<job id>.out in the working directory.`);
          break;
        default:
          notes.push(`#SBATCH ${opt[1]!.trim()} is not taken over.`);
      }
      return;
    }
    if (line.trim() && !line.trim().startsWith('#')) header = false;
    if (header && line.trim().startsWith('#')) return; // the file's own usage notes ("sbatch x.sbatch")
    if (SUBMIT_DIR_CD.test(line)) return; // the job already starts in the working directory
    body.push(line);
  });
  while (body.length && !body[0]!.trim()) body.shift();
  while (body.length && !body[body.length - 1]!.trim()) body.pop();
  if (body.some((l) => l.includes('SLURM_SUBMIT_DIR')))
    notes.push('It still uses $SLURM_SUBMIT_DIR; here that is not your project folder.');
  return { settings, commands: body.join('\n'), notes };
}

/** One-click setup lines for Commands (the lines most course instructions start with). */
export const SETUP_LINES = {
  cuda: 'export PATH=/opt/cuda-12.8.0/bin:$PATH',
  gpu: 'nvidia-smi -L',
  conda: (env: string) => `source "\${CONDA_BASE:-$HOME/miniconda3}/etc/profile.d/conda.sh"\nconda activate ${env}`,
};

/** Puts a setup line before the commands, once. */
export function withSetupLine(commands: string, line: string): string {
  if (commands.includes(line)) return commands;
  return commands.trim() ? `${line}\n${commands.replace(/^\n+/, '')}` : line;
}

/** A conda environment name as `conda activate` takes it. */
export const validCondaEnv = (n: string) => /^[\w.-]{1,64}$/.test(n);
