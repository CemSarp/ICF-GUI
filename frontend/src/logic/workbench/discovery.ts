import type { DevTask, Entry, TaskKind } from '../../types';

/**
 * Read-only task suggestions from files the project already has. Nothing here runs anything: a
 * Makefile is read as text, never by `make`, and a suggestion becomes a task only when the user adds
 * it (and can still edit it first).
 */
export interface Suggestion {
  name: string;
  kind: TaskKind;
  command: string;
  /** Where it came from, shown next to it. */
  source: string;
}

export const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];
const MAX_SUGGESTIONS = 20;
/** Targets that change the system or publish something: never suggested as development tasks. */
const NEVER =
  /^(install|uninstall|setup.*|deploy|publish|release|upload|push|dist|distclean|deps|depend|dependencies)$/i;

function kindOf(target: string): TaskKind {
  if (/^(all|build|compile)$/i.test(target)) return 'build';
  if (/^test|^check/i.test(target)) return 'test';
  if (/bench|perf|profile/i.test(target)) return 'benchmark';
  if (/^run/i.test(target)) return 'run';
  return 'custom';
}

/**
 * Ordinary targets of a Makefile, conservatively: rule lines `name [name…]: …` without variables,
 * patterns, paths or file-like names (`main.o`); with a `.PHONY` list only those (plus `all`).
 */
export function makeTargets(text: string): string[] {
  const lines = text.replace(/\\\n/g, ' ').split('\n');
  const phony = new Set<string>();
  const targets: string[] = [];
  for (const l of lines) {
    if (/^\s|^#/.test(l)) continue; // recipes and comments
    const p = /^\.PHONY\s*:(.*)$/.exec(l);
    if (p) {
      p[1]!
        .split(/\s+/)
        .filter(Boolean)
        .forEach((t) => phony.add(t));
      continue;
    }
    const m = /^([^:=#]+?)\s*:(?![=:])/.exec(l); // not `x := y`, `x ::= y` or `x::`
    if (!m) continue;
    for (const t of m[1]!.split(/\s+/)) {
      if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(t) && !targets.includes(t)) targets.push(t);
    }
  }
  const ok = phony.size ? targets.filter((t) => phony.has(t) || t === 'all') : targets;
  return ok.filter((t) => !NEVER.test(t));
}

/** pytest is suggested only with evidence the project uses it. */
export function usesPytest(names: string[], pyproject: string | null, setupCfg: string | null): boolean {
  return (
    names.includes('pytest.ini') ||
    names.includes('conftest.py') ||
    !!pyproject?.includes('[tool.pytest') ||
    !!setupCfg?.includes('[tool:pytest]')
  );
}

/** Which project files to read for suggestions (from one listing of the project folder). */
export function filesToRead(entries: Entry[]): { makefile: string | null; pyproject: boolean; setupCfg: boolean } {
  const files = entries.filter((e) => e.kind === 'file' || e.targetKind === 'file').map((e) => e.name);
  return {
    makefile: MAKEFILES.find((m) => files.includes(m)) ?? null,
    pyproject: files.includes('pyproject.toml'),
    setupCfg: files.includes('setup.cfg'),
  };
}

export function suggestions(
  makefile: { name: string; text: string } | null,
  pytest: boolean,
  existing: DevTask[],
): Suggestion[] {
  const out: Suggestion[] = [];
  if (makefile) {
    out.push({ name: 'Build', kind: 'build', command: 'make', source: `${makefile.name}: default target` });
    for (const t of makeTargets(makefile.text)) {
      if (t === 'all') continue; // `make` already builds the default target
      out.push({ name: `make ${t}`, kind: kindOf(t), command: `make ${t}`, source: makefile.name });
    }
  }
  if (pytest)
    out.push({ name: 'Run tests', kind: 'test', command: 'python -m pytest', source: 'pytest configuration' });
  const have = new Set(existing.map((t) => t.command.trim()));
  return out.filter((s) => !have.has(s.command)).slice(0, MAX_SUGGESTIONS);
}
