#!/usr/bin/env python3
"""Make the tiny dataset archive for testing training workflows. Runs on your Mac (stdlib only).

    python3 make_dataset.py            -> tiny_dataset.tar.gz   (train.csv, val.csv, README.txt)
    python3 make_dataset.py --unsafe   -> unsafe_dataset.tar.gz (has a ../escape.txt member)

Upload the archive with the app (Transfers, or "Upload an archive from this Mac…" in the workflow
wizard). The unsafe archive must be refused by the workflow before anything is unpacked or trained.
"""
import argparse
import csv
import io
import random
import tarfile


def rows(n, rng):
    """Two 2-D Gaussian blobs: label 0 around (-1, -1), label 1 around (1, 1)."""
    out = []
    for _ in range(n):
        label = rng.randint(0, 1)
        c = 1.0 if label else -1.0
        out.append((round(rng.gauss(c, 0.8), 4), round(rng.gauss(c, 0.8), 4), label))
    return out


def csv_bytes(data):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["x1", "x2", "label"])
    w.writerows(data)
    return buf.getvalue().encode()


def add(tf, name, data):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = 0o644
    tf.addfile(info, io.BytesIO(data))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--unsafe", action="store_true", help="make an archive the workflow must reject")
    ap.add_argument("--rows", type=int, default=2000)
    args = ap.parse_args()
    rng = random.Random(0)
    out = "unsafe_dataset.tar.gz" if args.unsafe else "tiny_dataset.tar.gz"
    with tarfile.open(out, "w:gz") as tf:
        add(tf, "train.csv", csv_bytes(rows(args.rows, rng)))
        add(tf, "val.csv", csv_bytes(rows(args.rows // 4, rng)))
        add(tf, "README.txt", b"Synthetic 2-D two-class data for ICF Control Center workflow tests.\n")
        if args.unsafe:
            add(tf, "../escape.txt", b"this file must never be written\n")
    print("wrote", out)


if __name__ == "__main__":
    main()
