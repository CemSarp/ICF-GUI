# Workflow smoke tests

Small files for testing ICF Control Center's V3 features on ICF with minimal resources. Every GPU test
below uses **Teaching, 1 GPU of the smallest type, 2 CPUs, 8 GB RAM, 10–15 min**.

| File | Where it runs | Purpose |
|---|---|---|
| `make_dataset.py` | your Mac (`python3 make_dataset.py`, stdlib only) | builds `tiny_dataset.tar.gz`; `--unsafe` builds `unsafe_dataset.tar.gz` (must be rejected) |
| `train_tiny.py` | GPU node, as the workflow script | tiny PyTorch run: data, GPU, checkpoints, metrics, outputs, SIGTERM, failure, resume |
| `smoke_notebook.ipynb` | GPU node, as a batch notebook | needs `nbconvert` and `ipykernel` in the environment |

Upload `train_tiny.py` and `smoke_notebook.ipynb` into the project folder (Transfers, or drag them into
VS Code), and the archive into `<project>/data` (the wizard's *Upload an archive from this Mac…* does it).

| Test | Workflow type | Arguments (one per line) | Other settings | Expected in Runs |
|---|---|---|---|---|
| 1. GPU check | GPU smoke test | — | dataset `tiny_dataset.tar.gz` | Completed; `smoke.json` in Outputs; log line `@@icfcc-smoke {… "cuda_available": true, "matmul_ok": true …}` |
| 2. Training | Training script `train_tiny.py` | `--data={data}/tiny_dataset` `--require-gpu` | same dataset | Completed; metrics chart; `summary.json`, `model.pt` in Outputs; `latest.pt` in Checkpoints |
| 3. Checkpoint sync | `train_tiny.py` | as 2 plus `--epochs=200` `--seconds-per-epoch=5` | sync every 5 min, wall time 15 min, copy-back warning 120 s | *Saving checkpoints* appears; *Timed out* with "outputs were copied back"; checkpoints synced |
| 4. Resume | `train_tiny.py` | as 2 plus `--resume={resume}` `--epochs=30` | Resume from: run 3's `checkpoints/latest.pt` (*Resume from this…*) | log says `resumed from … after epoch N` |
| 5. Failure | `train_tiny.py` | as 2 plus `--fail-at-epoch=3` | — | Failed: *Training script failed*, exit code 1; `summary.json` still copied back |
| 6. Unsafe data | `train_tiny.py` | as 2 | dataset `unsafe_dataset.tar.gz` | Failed: *Unsafe archive rejected*, training never starts, nothing extracted |
| 7. Notebook | Notebook, batch | entry `smoke_notebook.ipynb` | — | Completed; `smoke_notebook.executed.ipynb` and `notebook_smoke.json` in Outputs |
| 8. Cancel | `train_tiny.py` | as 3 | — | cancel from My Jobs → Cancelled; outputs copied back if the node had time |
