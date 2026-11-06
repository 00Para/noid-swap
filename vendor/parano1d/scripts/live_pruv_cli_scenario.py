#!/usr/bin/env python3
"""Exercise the documented Pruv CLI workflow on a stopped qualification fixture.

Run inside a loopback-only namespace. NOID_PRUV_CLI_SOURCE points to a passed,
stopped live_pruv_contract_scenario fixture; NOID_PRUV_LIVE_DIR is fresh.
Use the same NOID_PRUV_NODE/CLI/MINER/BIN/Z3 executable paths as that scenario.
"""

import json
import os
from pathlib import Path
import secrets
import subprocess

ROOT = Path(__file__).resolve().parents[1]
BASE = Path(os.environ["NOID_PRUV_LIVE_DIR"]).resolve()
os.environ["NOID_V2_LIVE_DIR"] = str(BASE)

import live_v2_contract_scenario as contracts

live = contracts.live
contracts.NODE = Path(os.environ["NOID_PRUV_NODE"]).resolve()
contracts.CLI = Path(os.environ["NOID_PRUV_CLI"]).resolve()
contracts.MINER = Path(os.environ["NOID_PRUV_MINER"]).resolve()
PRUV = Path(os.environ["NOID_PRUV_BIN"]).resolve()
Z3 = Path(os.environ["NOID_PRUV_Z3"]).resolve()
rpc = contracts.rpc


def main():
    devices = [line.split(":")[0].strip() for line in Path("/proc/net/dev").read_text().splitlines()[2:]]
    live.require(devices == ["lo"], "use a loopback-only network namespace")
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    source = Path(os.environ["NOID_PRUV_CLI_SOURCE"]).resolve()
    prior = json.loads((source / "report.json").read_text())
    live.require(prior["status"] == "passed" and not prior.get("shutdown_errors"), "source did not pass and stop")
    live.require(not BASE.exists(), "use a fresh output directory")
    for name in ("producer", "receiver"):
        live.require(subprocess.run(["fuser", "-s", str(source / name / "data/mdbx.dat")]).returncode == 1,
                     "source database is still open")
    BASE.mkdir(parents=True)
    (BASE / "logs").mkdir()
    artifacts = BASE / "artifacts"
    artifacts.mkdir()
    for name in ("producer", "receiver"):
        subprocess.run(["cp", "-a", "--reflink=auto", "--sparse=always", str(source / name), str(BASE / name)], check=True)
    key = BASE / "mining.key"
    key.write_text(secrets.token_hex(32) + "\n")
    key.chmod(0o600)
    live.BASE = BASE
    a = contracts.Node("producer", 27400, 27401, command_prefix=("taskset", "-c", "0,1,2,3,4,5,6,7"))
    b = contracts.Node("receiver", 27410, 27411, command_prefix=("taskset", "-c", "8,9,10,11"))
    report = {"status": "running", "negative_cases": {}, "commands": [], "source_tip": prior["final_tip"],
              "binary_sha256": {p.name: live.sha256(p) for p in (contracts.NODE, contracts.CLI, contracts.MINER, PRUV, Z3)},
              "script_sha256": live.sha256(__file__)}
    pending_cli = None

    def checkpoint(stage):
        report["stage"] = stage
        (BASE / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print("[stage] " + stage, flush=True)

    def cli(node, args):
        value = contracts.cli(node, args)
        report["commands"].append({"node": node.name, "command": str(args[0])})
        return value

    def mine(txid):
        live.wait_value("producer received CLI transaction", lambda: rpc(a, "getMempoolEntry", [txid]) is not None, 120)
        height = a.height() + 1
        with (BASE / "logs" / f"miner-{height}.log").open("w") as log:
            result = subprocess.run([str(contracts.MINER), "--rpc", f"http://127.0.0.1:{a.rpc_port}",
                "--key-file", str(key), "--threads", "2", "--rpc-timeout", "600", "--blocks", "1"],
                cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=900)
        live.require(result.returncode == 0 and a.height() == height, "finite mining failed")
        live.wait_value("wallet nodes select the CLI block", lambda: live.exact_tip(a, b), 600)

    def rejected(node, args):
        result = subprocess.run([str(contracts.CLI), "--rpc", f"http://127.0.0.1:{node.rpc_port}", "--json",
            "contract", *map(str, args)], cwd=ROOT, capture_output=True, text=True, timeout=60)
        live.require(result.returncode != 0, "invalid CLI call accepted")
        return result.stderr.strip()

    try:
        checkpoint("start both wallets on the stopped Pruv qualification chain")
        b.start("01-receiver")
        a.start("02-producer", mode="extminer", genesis=True, seeds=[b.seed])
        live.wait_value("wallet nodes agree before CLI workflow", lambda: live.exact_tip(a, b), 600)
        live.require(a.info() == prior["final_tip"], "source tip differs")
        payer = rpc(a, "walletActiveAddress")["address"]
        payee = rpc(b, "walletActiveAddress")["address"]
        deadline = a.height() + 3
        params = artifacts / "budget.params.json"
        params.write_text(json.dumps({"spending_key": payee, "recovery_key": payer, "recipient": payee,
            "recover_at": str(deadline), "budget": "10000000", "max_fee": "1000000", "max_payment": "1000000"}))
        definition = artifacts / "budget.json"
        for command in ("check", "verify", "build"):
            args = [str(PRUV), command, str(ROOT / "noid_pruv/examples/budget.pruv"), "--params", str(params)]
            if command == "verify": args += ["--z3", str(Z3)]
            if command == "build": args += ["--out", str(definition)]
            result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=60)
            live.require(result.returncode == 0, result.stderr)
        opening_path = artifacts / "budget.opening.json"
        original = cli(a, ["create", definition, "--out", opening_path])
        cli(b, ["watch", opening_path])
        funded = cli(a, ["fund", opening_path, "10"])
        mine(funded["txid"])
        instances = cli(b, ["instances", opening_path])
        live.require(len(instances["slots"]) == 1, "funded CLI instance missing")
        slot = instances["slots"][0]
        call_args = ["call", opening_path, slot["slot_index"], slot["creation_id"],
                     "--pay", "0.1", "--pay-to", payee]
        preview = cli(b, [*call_args, "--preview"])
        wrong_path = artifacts / "rejected.json"
        report["negative_cases"]["wrong_review"] = rejected(b, [*call_args, "--expected-txid", "00" * 32, "--out", wrong_path])
        live.require(not wrong_path.exists(), "rejected review created an authorization artifact")
        checkpoint("submit the reviewed payout and let the CLI save its confirmation receipt")
        first_path = artifacts / "call-1.json"
        args = [str(contracts.CLI), "--rpc", f"http://127.0.0.1:{b.rpc_port}", "--rpc-timeout", "600",
                "--json", "contract", *map(str, [*call_args, "--expected-txid", preview["txid"], "--out", first_path])]
        pending_cli = subprocess.Popen(args, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        def submitted():
            if pending_cli.poll() is not None:
                output, errors = pending_cli.communicate()
                raise live.LiveForkReorgError("CLI exited before submission: " + errors + output)
            try:
                value = json.loads(first_path.read_text())
                return value["transaction"]["txid"] if value.get("submission_status") == "submitted" else False
            except (OSError, json.JSONDecodeError):
                return False

        txid = live.wait_value("CLI saves exact authorized call", submitted, 120)
        mine(txid)
        output, errors = pending_cli.communicate(timeout=120)
        live.require(pending_cli.returncode == 0, errors)
        pending_cli = None
        confirmed = json.loads(output)
        receipt_path = first_path.with_suffix(".receipt")
        live.require(receipt_path.is_file() and confirmed["receipt"]["valid"], "CLI did not save verified receipt")
        for node in (a, b): live.require(cli(node, ["verify", receipt_path])["valid"], "CLI receipt verification failed")
        successor = cli(a, ["instances", first_path])["slots"][0]
        report["negative_cases"]["spent_predecessor"] = rejected(b, [*call_args, "--preview"])
        live.require(a.height() + 1 == deadline, "CLI recovery boundary differs")
        checkpoint("close the successor through CLI at the exact deadline")
        close_args = ["call", first_path, successor["slot_index"], successor["creation_id"], "--close"]
        close_preview = cli(a, [*close_args, "--preview"])
        live.require(close_preview["recovery"], "CLI did not select recovery")
        close_path = artifacts / "closing.json"
        closed = cli(a, [*close_args, "--expected-txid", close_preview["txid"], "--wait-seconds", "0", "--out", close_path])
        mine(closed["transaction"]["txid"])
        live.require(closed["successor"] is None, "CLI closing created a successor")
        close_receipt = artifacts / "closing.receipt"
        cli(a, ["receipt", first_path, closed["transaction"]["txid"], "--out", close_receipt])
        for node in (a, b): live.require(cli(node, ["verify", close_receipt])["valid"], "CLI close receipt failed")
        live.require(cli(a, ["instances", first_path])["slots"] == [], "closed contract remains spendable")
        report.update(status="passed", final_tip=a.info(), original=original,
                      payout_call=confirmed, closing_call=closed,
                      receipts={p.name: {"bytes": p.stat().st_size, "sha256": live.sha256(p)} for p in (receipt_path, close_receipt)})
        checkpoint("complete")
    except Exception as error:
        report.update(status="failed", error=str(error))
        checkpoint("failed")
        raise
    finally:
        if pending_cli is not None and pending_cli.poll() is None:
            pending_cli.terminate()
            pending_cli.communicate(timeout=15)
        for node in (a, b): node.request_stop()
        for node in (a, b):
            try: node.finish_stop()
            except Exception as error: report.setdefault("shutdown_errors", []).append(str(error))
        if report.get("shutdown_errors"): report["status"] = "failed"
        (BASE / "report.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
