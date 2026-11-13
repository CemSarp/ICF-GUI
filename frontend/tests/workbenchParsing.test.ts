import { describe, expect, it } from 'vitest';
import { analyze, MAX_DIAGNOSTICS, resolveInProject, verdict } from '../src/logic/workbench/diagnostics';
import { filesToRead, makeTargets, suggestions, usesPytest } from '../src/logic/workbench/discovery';
import type { Entry } from '../src/types';

const P = '/home/s1/my-cuda-project';

describe('Compiler and test output', () => {
  it('reads nvcc device errors with their continuation lines, and links files inside the project', () => {
    const out = [
      'nvcc -O2 -o app src/kernel.cu src/main.cpp',
      'src/kernel.cu(42): error: identifier "idx" is undefined',
      '      out[idx] = a[i] + b[i];',
      '          ^',
      '',
      'src/kernel.cu(57): warning #177-D: variable "tmp" was declared but never referenced',
      '1 error detected in the compilation of "src/kernel.cu".',
    ].join('\n');
    const a = analyze(out, P, P);
    expect(a.diagnostics).toHaveLength(2);
    expect(a.diagnostics[0]).toMatchObject({
      severity: 'error',
      file: 'src/kernel.cu',
      path: `${P}/src/kernel.cu`,
      line: 42,
      column: null,
      message: 'identifier "idx" is undefined',
      detail: ['      out[idx] = a[i] + b[i];', '          ^'],
    });
    expect(a.diagnostics[1]).toMatchObject({ severity: 'warning', line: 57 });
    expect(verdict('failed', 2, a)).toBe('Failed (exit code 2) — 1 compiler error · 1 warning.');
  });

  it('reads several GCC/Clang diagnostics with columns, ANSI colours, duplicates and notes', () => {
    const out = [
      '\u001b[01m\u001b[Ksrc/main.cpp:10:5:\u001b[m\u001b[K \u001b[01;31m\u001b[Kerror: \u001b[m\u001b[K‘foo’ was not declared in this scope',
      'src/main.cpp:10:5: error: ‘foo’ was not declared in this scope',
      'src/main.cpp:12:1: fatal error: missing.h: No such file or directory',
      'In file included from src/a.h:3,',
      '/usr/include/c++/11/bits/stl_vector.h:1120:7: note: candidate expects 1 argument',
      'make: *** [Makefile:12: all] Error 1',
      'error: something without a location',
    ].join('\n');
    const a = analyze(out, P, P);
    expect(a.diagnostics.map((d) => [d.severity, d.file, d.line, d.column])).toEqual([
      ['error', 'src/main.cpp', 10, 5],
      ['error', 'src/main.cpp', 12, 1],
      ['note', '/usr/include/c++/11/bits/stl_vector.h', 1120, 7],
    ]);
    expect(a.diagnostics[2]!.path).toBeNull(); // shown, but not a project file
  });

  it('only links paths that stay inside the project', () => {
    expect(resolveInProject('kernel.cu', `${P}/src`, P)).toBe(`${P}/src/kernel.cu`);
    expect(resolveInProject('../include/x.h', `${P}/src`, P)).toBe(`${P}/include/x.h`);
    expect(resolveInProject(`${P}/src/./k.cu`, P, P)).toBe(`${P}/src/k.cu`);
    expect(resolveInProject('../../etc/passwd', `${P}/src`, P)).toBeNull();
    expect(resolveInProject('/home/s1/other/x.cu', P, P)).toBeNull();
    expect(resolveInProject('<command-line>', P, P)).toBeNull();
    expect(resolveInProject(`${P}-evil/x.cu`, P, P)).toBeNull();
  });

  it('keeps Python traceback frames from the project only', () => {
    const out = [
      'Traceback (most recent call last):',
      `  File "${P}/main.py", line 7, in <module>`,
      '  File "/usr/lib/python3.12/site-packages/torch/nn/x.py", line 1, in f',
      'RuntimeError: CUDA error: out of memory',
    ].join('\n');
    const a = analyze(out, P, P);
    expect(a.diagnostics).toHaveLength(1);
    expect(a.diagnostics[0]).toMatchObject({ path: `${P}/main.py`, line: 7 });
    expect(a.hints.some((h) => h.includes('ran out of memory'))).toBe(true);
  });

  it('counts reported test results without trusting every mention of PASS or FAIL', () => {
    const lines = analyze(
      'PASS test_rope\nFAIL test_softmax\n[ PASS ] matmul\nthe word FAIL in a sentence\nALL PASS',
      P,
      P,
    );
    expect(lines.tests).toEqual({ passed: 2, failed: 1, source: 'lines' });
    const py = analyze('tests/test_a.py::test_x PASSED\n===== 1 failed, 12 passed, 1 skipped in 3.21s =====', P, P);
    expect(py.tests).toEqual({ passed: 12, failed: 1, source: 'pytest' });
    expect(analyze('nothing to see', P, P).tests).toBeNull();
  });

  it('calls out reported failures when the exit code says success', () => {
    const a = analyze('PASS a\nFAIL b\nFAIL c', P, P);
    expect(verdict('succeeded', 0, a)).toMatch(/^Exit code 0, but the output reports 2 failures/);
    expect(verdict('succeeded', 0, analyze('PASS a', P, P))).toBe(
      'Succeeded (exit code 0) — 1 reported pass, 0 reported fail.',
    );
    expect(verdict('succeeded', 0, analyze('make: Nothing to be done', P, P))).toBeNull(); // the badge says it
    expect(verdict('failed', 1, analyze('oops', P, P))).toBeNull();
  });

  it('gives short CUDA hints for recognisable problems', () => {
    const hint = (s: string) => analyze(s, P, P).hints.join(' ');
    expect(hint('CUDA error: an illegal memory access was encountered')).toMatch(/compute-sanitizer/);
    expect(hint('sh: nvcc: command not found')).toMatch(/CUDA toolchain/);
    expect(hint('CUDA error: no kernel image is available for execution on the device')).toMatch(/-arch/);
    expect(hint('========= Race reported between Write access')).toMatch(/racecheck/);
    expect(hint('all good')).toBe('');
  });

  it('stays bounded on huge or malformed output', () => {
    const many = Array.from({ length: 10_000 }, (_, i) => `src/k.cu:${i + 1}:1: error: e${i}`).join('\n');
    const t0 = performance.now();
    const a = analyze(`${many}\n${'x'.repeat(200_000)}:1:1: error: long\n\u0000\u0007garbage(((:::`, P, P);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(a.diagnostics).toHaveLength(MAX_DIAGNOSTICS);
    expect(a.truncated).toBe(true);
    expect(analyze('', P, P)).toEqual({ diagnostics: [], truncated: false, tests: null, hints: [] });
  });
});

const entry = (name: string, kind: Entry['kind'] = 'file'): Entry => ({
  name,
  kind,
  targetKind: null,
  size: 1,
  modified: null,
  mode: '-rw-r--r--',
  mine: true,
  unsupported: false,
});

describe('Task suggestions', () => {
  it('reads ordinary targets of a generic CUDA Makefile, honouring .PHONY', () => {
    const mk = [
      'NVCC := nvcc',
      'ARCH ?= sm_75',
      'SRC = src/kernel.cu src/main.cpp',
      '.PHONY: all test clean run benchmark install',
      'all: app',
      'app: $(SRC)',
      '\t$(NVCC) -arch=$(ARCH) -o $@ $^',
      '%.o: %.cu',
      'test: app',
      '\t./app --test',
      'benchmark: app',
      'run: app',
      'clean:',
      '\trm -f app',
      'install:',
      '# notes: not a target',
    ].join('\n');
    expect(makeTargets(mk)).toEqual(['all', 'test', 'benchmark', 'run', 'clean']);
    const s = suggestions({ name: 'Makefile', text: mk }, false, []);
    expect(s.map((x) => [x.command, x.kind])).toEqual([
      ['make', 'build'],
      ['make test', 'test'],
      ['make benchmark', 'benchmark'],
      ['make run', 'run'],
      ['make clean', 'custom'],
    ]);
  });

  it('without .PHONY, skips files, patterns, variables and system targets', () => {
    const mk =
      'CXX=g++\nbuild: main.o util.o\nmain.o: main.cpp\n$(BIN): x\ntest check: build\nsetup-env:\ndeploy:\nx::\nobj/%.o: %.cpp\n';
    expect(makeTargets(mk)).toEqual(['build', 'test', 'check']);
  });

  it('works for a course-style Makefile with numbered test targets (a fixture, not special-cased)', () => {
    const mk =
      '.PHONY: all test test1 test2 test3 test4 clean\nall:\n\tnvcc ...\ntest: test1 test2 test3 test4\ntest1:\ntest2:\ntest3:\ntest4:\nclean:\n';
    expect(suggestions({ name: 'Makefile', text: mk }, false, []).map((s) => s.command)).toEqual([
      'make',
      'make test',
      'make test1',
      'make test2',
      'make test3',
      'make test4',
      'make clean',
    ]);
  });

  it('suggests pytest only with evidence, nothing without a build system, and not what is already a task', () => {
    expect(usesPytest(['main.py', 'requirements.txt'], null, null)).toBe(false);
    expect(usesPytest(['conftest.py'], null, null)).toBe(true);
    expect(usesPytest(['pyproject.toml'], '[tool.pytest.ini_options]\n', null)).toBe(true);
    expect(usesPytest(['pyproject.toml'], '[project]\nname="x"\n', null)).toBe(false);
    expect(suggestions(null, false, [])).toEqual([]);
    expect(suggestions(null, true, [])).toEqual([
      { name: 'Run tests', kind: 'test', command: 'python -m pytest', source: 'pytest configuration' },
    ]);
    const existing = [{ id: 'b', name: 'B', kind: 'build' as const, command: 'make', workingDir: '', description: '' }];
    expect(suggestions({ name: 'Makefile', text: 'all:\n' }, false, existing)).toEqual([]);
    expect(filesToRead([entry('Makefile'), entry('pyproject.toml'), entry('src', 'dir')])).toEqual({
      makefile: 'Makefile',
      pyproject: true,
      setupCfg: false,
    });
  });
});
