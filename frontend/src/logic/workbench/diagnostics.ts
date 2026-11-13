/**
 * Compiler and test output → a short structured summary. Generic patterns only (GCC/Clang/nvcc,
 * Python tracebacks, PASS/FAIL lines, pytest's summary); nothing course- or framework-specific.
 * The raw output is always shown as well: whatever is not recognised simply stays text, and a
 * parser problem never affects a run's status, which comes from its exit code.
 */

export type Severity = 'error' | 'warning' | 'note';

export interface Diagnostic {
  severity: Severity;
  /** As printed. */
  file: string;
  /** Absolute path inside the project when it resolves there, else null (shown, not linked). */
  path: string | null;
  line: number;
  column: number | null;
  message: string;
  /** Continuation lines (source excerpt, caret, "detected during …"), at most a few. */
  detail: string[];
  /** The raw line, for the full message. */
  raw: string;
}

export interface TestSummary {
  passed: number;
  failed: number;
  /** Where the counts came from: individual PASS/FAIL lines, or a test runner's own summary. */
  source: 'lines' | 'pytest';
}

export interface Analysis {
  diagnostics: Diagnostic[];
  /** More were found than are listed. */
  truncated: boolean;
  tests: TestSummary | null;
  hints: string[];
}

export const MAX_DIAGNOSTICS = 200;
const MAX_LINE = 2000;
const MAX_DETAIL = 4;

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
/** `file:line[:col]: error|warning|note: msg` (GCC, Clang, nvcc's host compiler). */
const GCC = /^([^\s:][^:]*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note)\s*:\s*(.*)$/i;
/** `file(line): error: msg` (nvcc / cudafe for device code, also MSVC-style). */
const PAREN = /^([^\s(][^(]*?)\((\d+)\)\s*:\s*(error|warning|note|remark)(?:\s+#[\w-]+)?\s*:\s*(.*)$/i;
/** `  File "x.py", line 12, in f` (Python traceback frame). */
const PY = /^\s*File "([^"]+)", line (\d+)/;
const PASS_FAIL = /^\s*(?:\[\s*)?(PASS(?:ED)?|FAIL(?:ED|URE)?)\b/;
/** pytest's last line: `===== 2 failed, 12 passed, 1 skipped in 3.21s =====`. */
const PYTEST = /^=+ .*\b(?:passed|failed)\b.* in [\d.]+s(?: \([^)]*\))? =+$/;

const HINTS: [RegExp, string][] = [
  [
    /illegal memory access|misaligned address|cudaErrorIllegalAddress|CUDA_ERROR_ILLEGAL_ADDRESS/i,
    'A kernel read or wrote memory it does not own. Check index calculations and array bounds; running the program under `compute-sanitizer` shows the faulting access.',
  ],
  [
    /out of memory|cudaErrorMemoryAllocation|CUDA_ERROR_OUT_OF_MEMORY/i,
    'The GPU ran out of memory. Check batch or problem sizes and buffers that are never freed, or ask for a GPU with more memory.',
  ],
  [
    /nvcc: (?:command )?not found|nvcc: No such file/i,
    'nvcc was not found in the session. Choose a CUDA toolchain for the project (Files & environment) and start a new session.',
  ],
  [
    /no kernel image is available|unsupported gpu architecture|invalid device function|cudaErrorNoKernelImageForDevice/i,
    'The program was not compiled for this GPU. Check the -arch / -gencode flags against the GPU the session got (`nvidia-smi --query-gpu=name,compute_cap --format=csv`) and rebuild.',
  ],
  [
    /racecheck|\brace (?:hazard|condition)|Race reported/i,
    'Possible shared-memory race. Check that every thread reaches each __syncthreads() before shared data is reused; `compute-sanitizer --tool racecheck` reports hazards.',
  ],
  [
    /no CUDA-capable device|CUDA driver version is insufficient|cudaErrorNoDevice/i,
    'The program saw no usable GPU. Check it ran inside the GPU session and does not change CUDA_VISIBLE_DEVICES.',
  ],
  [
    /Segmentation fault|core dumped/i,
    'The program crashed with a segmentation fault (host code). Check pointers and array bounds; `compute-sanitizer` or `gdb` can locate it.',
  ],
];

/** `a/./b/../c` → `a/c`; null if it climbs above the root. */
function normalize(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return `/${out.join('/')}`;
}

/** The file as an absolute path inside the project, or null (outside, or not a plain path). */
export function resolveInProject(file: string, workingDir: string, project: string): string | null {
  if (!file || file.includes('\0') || /[<>]/.test(file)) return null;
  const abs = normalize(file.startsWith('/') ? file : `${workingDir}/${file}`);
  const root = project.replace(/\/+$/, '');
  return abs && abs.startsWith(`${root}/`) ? abs : null;
}

export function analyze(output: string, workingDir: string, project: string): Analysis {
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let pass = 0;
  let fail = 0;
  let pytest: TestSummary | null = null;
  let last: Diagnostic | null = null;

  for (const rawLine of output.replace(ANSI, '').split('\n')) {
    const line = rawLine.length > MAX_LINE ? rawLine.slice(0, MAX_LINE) : rawLine.replace(/\r$/, '');
    let d: Diagnostic | null = null;
    let m = GCC.exec(line);
    if (m) {
      const sev = m[4]!.toLowerCase();
      d = {
        severity: sev.includes('error') ? 'error' : sev === 'warning' ? 'warning' : 'note',
        file: m[1]!,
        path: null,
        line: Number(m[2]),
        column: m[3] ? Number(m[3]) : null,
        message: m[5]!.trim(),
        detail: [],
        raw: line,
      };
    } else if ((m = PAREN.exec(line))) {
      const sev = m[3]!.toLowerCase();
      d = {
        severity: sev === 'error' ? 'error' : sev === 'warning' ? 'warning' : 'note',
        file: m[1]!.trim(),
        path: null,
        line: Number(m[2]),
        column: null,
        message: m[4]!.trim(),
        detail: [],
        raw: line,
      };
    } else if ((m = PY.exec(line))) {
      const path = resolveInProject(m[1]!, workingDir, project);
      // Only frames in the project: library frames are noise here and stay in the raw output.
      if (path)
        d = {
          severity: 'note',
          file: m[1]!,
          path,
          line: Number(m[2]),
          column: null,
          message: 'Traceback',
          detail: [],
          raw: line.trim(),
        };
    }

    if (d) {
      d.path ??= resolveInProject(d.file, workingDir, project);
      const key = `${d.severity}|${d.path ?? d.file}|${d.line}|${d.column}|${d.message}`;
      last = null;
      if (seen.has(key)) continue;
      seen.add(key);
      if (diagnostics.length >= MAX_DIAGNOSTICS) {
        truncated = true;
        continue;
      }
      diagnostics.push(d);
      last = d;
      continue;
    }
    if (last && line.trim() && /^\s/.test(line) && last.detail.length < MAX_DETAIL) {
      last.detail.push(line.trimEnd());
      continue;
    }
    last = null;

    const t = line.trim();
    if (PYTEST.test(t)) {
      pytest = {
        passed: Number(/(\d+) passed/.exec(t)?.[1] ?? 0),
        failed: Number(/(\d+) failed/.exec(t)?.[1] ?? 0) + Number(/(\d+) errors?\b/.exec(t)?.[1] ?? 0),
        source: 'pytest',
      };
      continue;
    }
    const pf = PASS_FAIL.exec(line);
    if (pf) {
      if (pf[1]!.toUpperCase().startsWith('FAIL')) fail++;
      else pass++;
    }
  }

  return {
    diagnostics,
    truncated,
    tests: pytest ?? (pass + fail > 0 ? { passed: pass, failed: fail, source: 'lines' } : null),
    hints: HINTS.filter(([re]) => re.test(output)).map(([, h]) => h),
  };
}

/**
 * One sentence for a finished run: the exit code decides success; reported test failures with exit
 * code 0 are called out instead of being hidden.
 */
export function verdict(status: string, exitCode: number | null, a: Analysis): string | null {
  const errors = a.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = a.diagnostics.filter((d) => d.severity === 'warning').length;
  const parts: string[] = [];
  if (errors) parts.push(`${errors} compiler error${errors === 1 ? '' : 's'}`);
  if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  if (a.tests) parts.push(`${a.tests.passed} reported pass, ${a.tests.failed} reported fail`);
  const found = parts.join(' · ');
  if (status === 'succeeded' && a.tests && a.tests.failed > 0)
    return `Exit code 0, but the output reports ${a.tests.failed} failure${a.tests.failed === 1 ? '' : 's'}. The command's own exit code says it succeeded; check the output.`;
  if (status === 'failed') return `Failed (exit code ${exitCode ?? '?'})${found ? ` — ${found}` : ''}.`;
  if (status === 'succeeded') return `Succeeded (exit code 0)${found ? ` — ${found}` : ''}.`;
  return found || null;
}
