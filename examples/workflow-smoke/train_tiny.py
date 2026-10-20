#!/usr/bin/env python3
"""Tiny PyTorch training run for testing ICF Control Center training workflows.

Upload it to your ICF project folder and choose it as the workflow script. It needs no real compute
(a few seconds per run on any GPU) but exercises everything the workflow provides: data staged to
scratch, the GPU, checkpoints, metrics, outputs copied back, the time-limit warning (SIGTERM), a
controlled failure, and resume.

Arguments (one per line in the wizard):
    --data={data}/tiny_dataset    folder with train.csv / val.csv (this is also the default)
    --epochs=20
    --seconds-per-epoch=0         sleep per epoch to make the run last longer
    --fail-at-epoch=-1            raise an error at this epoch (test failure handling)
    --resume={resume}             checkpoint file or folder (default: $ICFCC_RESUME_FROM)
    --require-gpu                 exit with code 3 if CUDA is not available

Writes: checkpoints to $ICFCC_CHECKPOINT_DIR (epoch-NNN.pt, latest.pt), one JSON line per epoch to
$ICFCC_METRICS_FILE, and summary.json / model.pt to $ICFCC_OUTPUT_DIR.
"""
import argparse
import csv
import json
import os
import signal
import sys
import time

import torch
from torch import nn

STOP = {"signal": None}


def on_signal(signum, _frame):
    # SLURM (via the workflow) sends SIGTERM before the time limit and on cancel: finish the epoch,
    # save, and exit so the job can copy results back.
    STOP["signal"] = signal.Signals(signum).name


def load(path, device):
    xs, ys = [], []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            xs.append([float(row["x1"]), float(row["x2"])])
            ys.append(int(row["label"]))
    return torch.tensor(xs, device=device), torch.tensor(ys, device=device)


def atomic_save(obj, path):
    tmp = path + ".tmp"
    torch.save(obj, tmp)
    os.replace(tmp, path)  # a checkpoint is either complete or absent, never half-written


def load_checkpoint(path, device):
    if os.path.isdir(path):
        path = os.path.join(path, "latest.pt")
    try:
        return path, torch.load(path, map_location=device, weights_only=True)
    except TypeError:  # torch < 1.13 has no weights_only
        return path, torch.load(path, map_location=device)


def write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)


def main():
    env = os.environ.get
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=os.path.join(env("ICFCC_DATA_DIR", "data"), "tiny_dataset"))
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--seconds-per-epoch", type=float, default=0.0)
    ap.add_argument("--fail-at-epoch", type=int, default=-1)
    ap.add_argument("--resume", default=env("ICFCC_RESUME_FROM", ""))
    ap.add_argument("--require-gpu", action="store_true")
    args = ap.parse_args()

    signal.signal(signal.SIGTERM, on_signal)
    out_dir = env("ICFCC_OUTPUT_DIR", "outputs")
    ckpt_dir = env("ICFCC_CHECKPOINT_DIR", "checkpoints")
    metrics_path = env("ICFCC_METRICS_FILE")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(ckpt_dir, exist_ok=True)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    gpu = torch.cuda.get_device_name(0) if device == "cuda" else None
    print(f"python {sys.version.split()[0]} torch {torch.__version__} (CUDA build {torch.version.cuda}) device {device} {gpu or ''}", flush=True)
    if args.require_gpu and device != "cuda":
        print("ERROR: CUDA is not available on this node (wrong partition, toolchain or PyTorch build?)", file=sys.stderr, flush=True)
        return 3

    xtr, ytr = load(os.path.join(args.data, "train.csv"), device)
    xva, yva = load(os.path.join(args.data, "val.csv"), device)
    print(f"data: {len(xtr)} train / {len(xva)} val rows from {args.data}", flush=True)

    torch.manual_seed(0)
    model = nn.Sequential(nn.Linear(2, 32), nn.ReLU(), nn.Linear(32, 2)).to(device)
    lr = 0.1
    opt = torch.optim.SGD(model.parameters(), lr=lr)
    loss_fn = nn.CrossEntropyLoss()
    start = 0
    if args.resume:
        path, ck = load_checkpoint(args.resume, device)
        model.load_state_dict(ck["model"])
        opt.load_state_dict(ck["optimizer"])
        start = int(ck["epoch"])
        print(f"resumed from {path} after epoch {start}", flush=True)

    batch = 64
    steps_per_epoch = (len(xtr) + batch - 1) // batch
    summary = {"device": device, "gpu": gpu, "torch": torch.__version__, "resumed_from_epoch": start, "epochs_completed": start}
    for epoch in range(start + 1, args.epochs + 1):
        t0 = time.time()
        model.train()
        perm = torch.randperm(len(xtr), device=device)
        total = 0.0
        for i in range(0, len(xtr), batch):
            idx = perm[i : i + batch]
            opt.zero_grad()
            loss = loss_fn(model(xtr[idx]), ytr[idx])
            loss.backward()
            opt.step()
            total += loss.item() * len(idx)
        model.eval()
        with torch.no_grad():
            out = model(xva)
            val_loss = loss_fn(out, yva).item()
            acc = (out.argmax(1) == yva).float().mean().item()

        state = {"model": model.state_dict(), "optimizer": opt.state_dict(), "epoch": epoch}
        atomic_save(state, os.path.join(ckpt_dir, f"epoch-{epoch:03d}.pt"))
        atomic_save(state, os.path.join(ckpt_dir, "latest.pt"))
        old = os.path.join(ckpt_dir, f"epoch-{epoch - 3:03d}.pt")
        if os.path.exists(old):
            os.remove(old)  # keep the last three: small checkpoints, light NFS syncs

        rec = {"step": epoch * steps_per_epoch, "epoch": epoch, "loss": total / len(xtr), "val_loss": val_loss, "accuracy": acc, "lr": lr}
        if device == "cuda":
            rec["gpu_mem_gb"] = torch.cuda.max_memory_allocated() / 1e9
        print(json.dumps(rec), flush=True)
        if metrics_path:
            with open(metrics_path, "a") as f:
                f.write(json.dumps(rec) + "\n")
        summary.update(epochs_completed=epoch, val_loss=val_loss, val_accuracy=acc)
        write_json(os.path.join(out_dir, "summary.json"), summary)

        if epoch == args.fail_at_epoch:
            raise RuntimeError(f"controlled failure at epoch {epoch} (--fail-at-epoch)")
        while time.time() - t0 < args.seconds_per_epoch and not STOP["signal"]:
            time.sleep(0.2)
        if STOP["signal"]:
            print(f"received {STOP['signal']}: saved epoch {epoch}, stopping early", flush=True)
            summary["stopped_by"] = STOP["signal"]
            break

    torch.save(model.state_dict(), os.path.join(out_dir, "model.pt"))
    write_json(os.path.join(out_dir, "summary.json"), summary)
    print(f"done: {summary['epochs_completed']} epochs, val accuracy {summary.get('val_accuracy', 0):.3f}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
