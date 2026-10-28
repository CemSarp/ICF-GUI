/** Log lines worth reading first: test failures, compiler/Python errors, a failed session block. */
const PROBLEM =
  /\bFAIL(ED)?\b|\berror:|\bError:|Traceback \(most recent call last\)|Segmentation fault|CUDA error|out of memory|@@icfcc-block \d+ end rc=[1-9]/i;
const MAX_PROBLEMS = 20;

/** The first lines of a log that look like problems, each once, at most 20 (with their line number). */
export function problemLines(text: string): { n: number; line: string }[] {
  const seen = new Set<string>();
  const out: { n: number; line: string }[] = [];
  text.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (out.length < MAX_PROBLEMS && PROBLEM.test(t) && !seen.has(t)) {
      seen.add(t);
      out.push({ n: i + 1, line: t });
    }
  });
  return out;
}

export type ScriptLineKind = 'slurm' | 'yours' | 'app';

/**
 * The reviewed batch script, line by line: `#SBATCH`/comments (`slurm`), lines the user typed
 * (`yours`), and everything the app adds from the settings (`app`: environment, setup, the run
 * line), so an added line such as `source …/activate` stands out at first glance.
 */
export function annotateScript(script: string, typed: string): { line: string; kind: ScriptLineKind }[] {
  const mine = new Set(
    typed
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim()),
  );
  return script.split('\n').map((line) => ({
    line,
    kind: line.startsWith('#') || !line.trim() ? 'slurm' : mine.has(line.trimEnd()) ? 'yours' : 'app',
  }));
}
