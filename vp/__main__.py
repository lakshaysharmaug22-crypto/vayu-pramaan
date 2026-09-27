"""CLI: python -m vp <command>"""
import argparse
import json
import sys


def main(argv=None):
    ap = argparse.ArgumentParser(prog="vp", description="Vayu Pramaan pipeline")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run the pipeline")
    r.add_argument("--mode", choices=["daily", "history", "build"], default="daily")
    r.add_argument("--synthetic", action="store_true", help="generate fake raw data (offline testing)")
    r.add_argument("--no-commit", action="store_true", help="don't append to the ledger")
    r.add_argument("--no-llm", action="store_true", help="skip AI brief + agent eval")
    sub.add_parser("verify", help="re-derive and check the whole ledger chain")
    a = sub.add_parser("ask", help="ask the analyst agent a question")
    a.add_argument("question")
    sub.add_parser("eval", help="run the 25-question agent eval")
    r.add_argument("--synthetic-dirs", action="store_true", help=argparse.SUPPRESS)
    for sp in (sub.choices["verify"], a, sub.choices["eval"]):
        sp.add_argument("--synthetic", action="store_true", help="use the synthetic sandbox")
    args = ap.parse_args(argv)
    if getattr(args, "synthetic", False):
        import os
        os.environ["VP_SYNTHETIC"] = "1"

    if args.cmd == "run":
        from .pipeline import run
        doc = run(args.mode, synthetic=args.synthetic, commit_ledger=not args.no_commit, with_llm=not args.no_llm)
        print(json.dumps({"run_id": doc["run_id"], "status": doc["status"], "stages": doc["stages"]}, indent=2, default=str))
        sys.exit(1 if doc["status"] == "failed" else 0)
    if args.cmd == "verify":
        from . import ledger
        v = ledger.verify(); print(json.dumps(v, indent=2)); sys.exit(0 if v["ok"] else 1)
    if args.cmd == "ask":
        from .agent import ask, readonly_con
        print(json.dumps(ask(readonly_con(), args.question), indent=2, default=str))
    if args.cmd == "eval":
        from .agent import readonly_con, run_eval
        res = run_eval(readonly_con())
        print(f"{res['passed']}/{res['total']} passed", json.dumps(res["by_category"], indent=2, default=str))


if __name__ == "__main__":
    main()
