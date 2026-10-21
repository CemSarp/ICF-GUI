# UI/UX pass and feature roadmap

Date: 2026-10-20 · App version 0.3.0 · Scope: the whole React UI (every screen, dialog and button).

This document has two parts:

1. What the UI pass changed.
2. Features worth adding next. They come from actually using the app to run the SemEval notebook on ICF overnight, not from guesswork.

---

## Part 1 — What the UI pass changed

### Design system (Apple-style, `src/styles/tokens.css`)

| Area | Before | After |
|---|---|---|
| Colours | Slate/Tailwind palette | macOS system colours. Text uses their accessible (AA) variants: blue `#0071e3`, green `#248a3d`, orange `#c93400`, red `#d70015`, purple `#8944ab`, with matching dark variants. |
| Surfaces | Grey cards with 1px borders on a slate background | Grouped surfaces: white cards with a hairline shadow on `#f5f5f7`. Dark mode uses `#161618` / `#232326`, with a separate sidebar material. |
| Spacing | Mixed px values | 4-pt scale (`--s1`…`--s6`), used consistently for card padding, gaps and section rhythm. |
| Radii | 6 / 8 / 12, used ad hoc | Control 8, card 12, sheet 16. |
| Type | 14 px everywhere, headings 22/16/14 | SF Pro Text/Display. Large title 26/700 (tight tracking); 17/600 section headings; 15/600 card headings; tabular figures for numbers. |
| Motion | One 160 ms token | `--dur-fast` 120 / `--dur` 200 / `--dur-slow` 320 ms, Apple's ease and sheet curves. All set to 0 when *Reduce motion* is on. |
| Native controls | Always followed the OS theme | `color-scheme` follows the chosen theme. **Bug fixed:** choosing *Light* while macOS was dark drew dark checkboxes, radios and scrollbars. |

### Components

- **Buttons:** three kinds — *filled* (primary), *tinted* (default) and *plain* (link-coloured, for toolbars and inline actions). Every button gets the same 32 px height, 8 px radius, hover tint and a 0.97 press scale. Disabled buttons are 40 % opacity with no press effect. Destructive buttons use red text plus a red hover tint.
- **Icons:** new outline icon set, drawn in the style of SF Symbols at 1.75 stroke (`Icon` in `components/ui.tsx`). Emoji and arrow glyphs are gone:
  - the file browser's 📁 📄 ↪;
  - the browser's ← → ↑ ⌂ buttons;
  - the ✕ remove/dismiss buttons;
  - the ↗ external-link arrows;
  - the transfer direction arrows.
- **Notices:** a tinted callout with an icon. Previously a coloured border with text glyphs.
- **Badges:** capsule shape, tinted fill, no outline. The text and glyph are kept, so state never depends on colour alone.
- **Segmented controls:** every `role=tablist` now renders as a macOS segmented control:
  - Training *New workflow / Runs*;
  - log *Standard output / Standard error*;
  - run *Outputs / Checkpoints / Partial copy*.

  The Settings theme picker is a segmented control too. It still uses radio buttons underneath, so the keyboard and screen readers work as before.
- **Steppers:** wizard steps and the run timeline use one stepper: dots and connector lines. The current step gets a ring, finished steps are green, a failed step is red. Before, these were outlined pills that looked like buttons.
- **Tables:** inside cards, tables run to the card edges with hairline row separators, a subtle row hover, sticky headers and no border on the last row.
- **Lists:**
  - **Runs** is now one grouped list with a chevron on each row, and the whole row is clickable. Before, each run was its own card.
  - **Transfers, project files and partitions** have their dividers and padding aligned.
- **Disclosure (`<details>`):** custom chevron that rotates on open, replacing the browser triangle.
- **Dialogs (sheets):** 16 px radius and a soft shadow. They animate in by scaling up and sliding into place. The scrim fades in. The sheet itself never animates opacity, so a stalled animation can't hide a confirmation.
- **Page transitions:** a short fade and 6 px rise when you switch screens. It's off when *Reduce motion* is on.

### Shell and navigation

- **Sidebar:**
  - Items are grouped under *Cluster*, *Jobs* and *Workspace*, and each has an icon.
  - *Settings* is pinned to the bottom.
  - The brand mark is an app-icon tile.
  - The footer now shows `Version 0.3.0` instead of a policy sentence.
- **Top toolbar:**
  - It uses a translucent material.
  - **Refresh** now only appears on the screens that use the cluster snapshot: Overview, Partitions, GPU Nodes, Request GPU and node detail.
  - It no longer appears on Settings, where it did nothing useful.
- **Page titles match the sidebar.** "Request GPU / Submit Job" became "Request GPU". Detail screens keep their section title, so you always know where you are.
- **Narrow windows:** the sidebar turns into a horizontal bar and labels no longer wrap.

### Button audit: redundancies and inconsistencies fixed

| Where | Problem | Fix |
|---|---|---|
| All detail screens | Four back-button wordings: "← Back to nodes", "← Back to My Jobs", "← All projects", "← All runs" | One `BackButton` with a chevron and an "All …" label: *All nodes, All jobs, All projects, All runs*. |
| Run detail | Two refresh buttons: the list's "Refresh runs" above, plus "Refresh job" | The list toolbar is hidden while a run is open. The run's **Refresh** now updates the workflow state *and* the scheduler details. Before, it only refreshed the scheduler details. |
| My Jobs / Training / Transfers / Job detail | Labels "Refresh jobs", "Refresh runs", "Refresh job", and a plain ghost "Refresh" | One **Refresh** (icon + label, tinted) per screen. |
| Settings | Toolbar showed the cluster Refresh, which has nothing to refresh on this screen | Removed. |
| Training wizard | Step chips showed internal states (Draft / Uploading / Validating / Ready / Submitting) | Same two steps as Request GPU: *Configure → Review & submit*. Uploading and checking already show their own notices. |
| Request GPU | Steps "1. Configure / 2. Review & submit" didn't mark step 1 done | Step 1 turns green once you are reviewing. |
| File browser | The current path was shown twice: as an input placeholder and as a code line | The path is now a clickable breadcrumb: click any folder inside your home to jump there. The input's placeholder became a hint. |
| File browser | Text-glyph navigation buttons (← → ↑ ⌂ "Refresh") | Icon buttons with tooltips. Their accessible names (*Back, Forward, Up one folder, Home folder, Refresh*) are unchanged. |
| Notices | A bold word in the middle of a sentence was forced onto its own line | Only the notice title is a block. |
| Sign-in | Said "Read-only: nothing is submitted to the scheduler", which has been untrue since 0.2.0 | "Nothing is submitted or changed on ICF until you confirm it." |
| Settings, Node detail, Overview | Internal version jargon: "not used in V1", "not measured in V1", "queue work later in V2" | Plain language. |

I checked every other button. Each one has a handler, a single clear label, and a consistent kind (filled / tinted / plain / destructive). Specifically:
- **Confirmation dialogs:** each pairs a safe default (Cancel / Keep) with the action.
- **Destructive actions** are red: *Cancel job…*, *Delete from Keychain*, *Forget saved password*.
- **External links** carry the external icon.

### Verification

- `pnpm lint`, `pnpm typecheck`, `pnpm test` (53/53) and `pnpm build` all pass. Three test expectations changed with the renamed labels:
  - the heading "Request GPU";
  - the button "Refresh";
  - "jobs screens show only their own Refresh", which now asserts exactly one Refresh button.
- **Checked by eye** in the UI preview at 1280×820 and 820×700, in both dark and light:
  - every screen: Overview, Partitions, GPU Nodes, Request GPU, My Jobs, Projects, project detail, Training wizard, Runs, run detail, Transfers, Settings, sign-in;
  - a dialog.
- **Not checked by eye:** the challenge (host-key) dialog, and the result screens after a real submission.

### Still worth doing on the UI (not done in this pass)

- **Split the large components.** `TrainingWizard.tsx` (≈1,100 lines) and `ProjectsView.tsx` (≈590) mix layout with logic; split them into section components.
- **Toasts for short-lived success messages.** "Copied", "Cached snapshot cleared" and "VS Code was asked…" are currently inline notices that move the layout.
- **Placeholder rows while tables load.** Today a "Loading…" line replaces the whole table.
- **Limit form width.** Request GPU and the Training wizard stretch to 1,280 px; about 880 px reads better.
- **Warn before leaving a half-filled wizard.** Ask "Discard changes?", or keep the draft automatically.

---

## Part 2 — Features to add, from real use

These come from the first real overnight run (SemEval notebook, dry run → LR probe → main → test). Each problem below actually happened during that run. Each feature keeps the app's rules: fixed commands only, anything that changes ICF needs your confirmation, and secrets never leave Rust memory or the Keychain.

### Priority 1 — would have saved hours this week

| # | Problem we hit | Feature | Notes |
|---|---|---|---|
| 1 | Typed `~/projects/icf-env/bin/python`; the app rejected it | **Expand `~` and `$HOME` in path fields**, and show the resolved path under the field. | The app already knows the remote home from the browse listing. |
| 2 | `torchvision` didn't match PyTorch; it was only found after a queue wait and a failed GPU job | **Environment check before submit:** one button runs `python -c "import …"` for the notebook's imports on the login node. It's read-only and imports nothing heavy on a GPU. Show missing or broken packages, with fixes. | The import list comes from the notebook or script; the command is a fixed template. It also catches a missing `nbconvert`/`ipykernel`. |
| 3 | `/disk/scratch` wasn't writable on landonia11 | *(fixed in 0.3.0: falls back to `$SLURM_TMPDIR`, then `/tmp`)*. Next: **show which scratch was used** in the run detail, and **let the user exclude nodes** (`--exclude`). | The `SCRATCH_FALLBACK` marker is already logged. |
| 4 | Stages had to be submitted by hand: probe → main → test | **Run after:** a "start after job X succeeds" option, using SLURM's `--dependency=afterok:<id>`. **Sequences:** save "dry run → probe → main → test" as one chain. | Each submission still shows its script and needs confirmation. The chain is just several confirmed submissions linked by dependencies. |
| 5 | Notebook runs show nothing until they end | **Live notebook progress:** run the notebook through a small runner that writes `@@icfcc CELL n/N` markers and streams each cell's output into the log. The runs view then shows "cell 37/69". | Same marker system as the existing workflow stages. |
| 6 | Going to bed meant not knowing whether the job failed at minute 2 | **Notifications:** (a) a macOS notification when a run changes state while the app is open; (b) a checkbox for SLURM e-mail on end/fail (`--mail-type=END,FAIL`), which works with the app closed. | (b) needs no polling at all; the address is your university e-mail. |

### Priority 2 — makes everyday use easier

| # | Feature | Why |
|---|---|---|
| 7 | **"Run again with changes"** on a finished run: opens the wizard pre-filled, with the notebook, job name and wall time highlighted. | Every stage this week was the same preset with three fields changed. |
| 8 | **Wall-time suggestions from history:** "Your last 3 runs of this preset took 1 h 52 m; suggested 2 h 50 m." Show the partition's MaxTime next to the field. | We guessed "2× the M5 Pro time"; real measurements are better. |
| 9 | **Estimated start time** for pending jobs (`squeue --start`, read-only) and the reason in plain words. | "Queued" says nothing about whether to wait or change partition. |
| 10 | **Efficiency report after a job** (`sacct` fields: CPU efficiency, peak RAM vs requested, run time vs limit), with suggestions such as "you requested 32 GB, peak was 9 GB". | Smaller requests start sooner and are fairer to other users. |
| 11 | **In-app viewer for executed notebooks:** cells, text output and plots straight from the run's Outputs, with no download. | Checking the probe meant downloading and opening a file every time. |
| 12 | **Quick look for results:** preview CSV, JSON, PNG and log files in the run's file list. | Most checks are "is the number in `results.csv` good?". |
| 13 | **Clearer failure explanations:** link common tracebacks to fixes, e.g. `operator torchvision::nms does not exist` → "torchvision doesn't match your PyTorch; remove it or pin a matching version". | The failure classes exist; add a small rules table that maps log lines to advice. |
| 14 | **Cancel from the run detail** (with the same confirmation), instead of going to My Jobs. | Removes a detour; the safety is the same. |
| 15 | **Home quota and usage** (`quota -s`, read-only) in Projects and Transfers, with a warning before large uploads or downloads. | A full `/home` silently breaks checkpoints and copying results back. |
| 16 | **Log tools:** search, auto-scroll while following, highlight `Traceback`/`Error`, "jump to first error". | Faster diagnosis without leaving the app. |

### Priority 3 — polish and power-user features

| # | Feature |
|---|---|
| 17 | **Keyboard shortcuts:** ⌘R refresh, ⌘1–⌘9 switch screens, ⌘N new workflow, ⌘K command palette ("open run train-4242", "upload to semeval/data"). |
| 18 | **Menu bar extra or Dock badge** showing how many jobs are running or pending, with a mini status list. |
| 19 | **First-run checklist:** SSH config, VS Code, Python environment, GPU smoke test, each turning green when done. It replaces the long prose the user has to read today. |
| 20 | **Guided environment setup** (a change on ICF, so confirmation is required): create the venv and install `requirements.txt` with the PyTorch/NumPy pins file. Show the exact commands first. |
| 21 | **Incremental folder sync** (rsync-style) for datasets and code, instead of packing a folder each time. |
| 22 | **Compare runs:** overlay the metric curves of several runs (e.g. the 3 seeds of `main`) and diff their configs. |
| 23 | **Accessibility:** a text-size setting (larger fonts without zooming the whole window), and a VoiceOver pass on the custom controls (segmented control, stepper, breadcrumbs). |

### Suggested order

1. **One small release (0.3.1):** #1, #2, #14 and #6b (SLURM e-mail). Each is small and removes the biggest frictions.
2. **Then:** #4 and #7 (chains and *Run again*). They turn the four-stage overnight flow into one confirmed plan.
3. **Then:** #5, #11 and #12 (seeing what a notebook is doing and what it produced).
4. **After that:** the rest, as real use asks for them.
