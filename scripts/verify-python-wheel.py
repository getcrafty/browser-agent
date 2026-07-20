from __future__ import annotations

import hashlib
import json
import os
import platform as host_platform
import subprocess
import sys
import tempfile
import venv
import zipfile
from pathlib import Path


def run(arguments: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments,
        check=True,
        capture_output=True,
        text=True,
        **kwargs,
    )


def host_key() -> str:
    machine = host_platform.machine().lower()
    architecture = {
        "aarch64": "arm64",
        "amd64": "x64",
        "x86_64": "x64",
    }.get(machine, machine)
    return f"{sys.platform}-{architecture}"


def main() -> None:
    if len(sys.argv) != 5:
        raise RuntimeError(
            "Usage: verify-python-wheel <wheel> <platform> <executable> <manifest>"
        )
    wheel = Path(sys.argv[1]).resolve()
    platform = sys.argv[2]
    tested_executable = Path(sys.argv[3]).resolve()
    manifest_path = Path(sys.argv[4]).resolve()
    suffix = ".exe" if platform.startswith("win32-") else ""
    executable_entry = f"browser_agent/bin/{platform}/browser-agent{suffix}"
    manifest_entry = "browser_agent/cli-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected_digest = manifest["platforms"][platform]["sha256"]
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
        executables = sorted(
            name
            for name in names
            if name.startswith("browser_agent/bin/")
            and name.rsplit("/", 1)[-1] in {"browser-agent", "browser-agent.exe"}
        )
        if executables != [executable_entry]:
            raise RuntimeError(
                f"Wheel must contain only {executable_entry}, found {executables}"
            )
        if executable_entry not in names or manifest_entry not in names:
            raise RuntimeError(
                f"Wheel is missing its executable or manifest: {wheel}"
            )
        packaged_executable = archive.read(executable_entry)
        if hashlib.sha256(packaged_executable).hexdigest() != expected_digest:
            raise RuntimeError("Wheel executable checksum differs from its manifest")
        if packaged_executable != tested_executable.read_bytes():
            raise RuntimeError("Wheel executable differs from the release asset")
        packaged_manifest = json.loads(archive.read(manifest_entry))
        if packaged_manifest != manifest:
            raise RuntimeError("Wheel manifest differs from the release manifest")
        if not platform.startswith("win32-"):
            mode = archive.getinfo(executable_entry).external_attr >> 16
            if mode & 0o111 == 0:
                raise RuntimeError(
                    f"Wheel executable lacks execute permissions: {oct(mode)}"
                )

    if platform != host_key():
        print(f"Python SDK wheel statically verified for {platform}.")
        return
    with tempfile.TemporaryDirectory(
        prefix="browser-agent-python-wheel-"
    ) as directory:
        environment = Path(directory) / "venv"
        venv.EnvBuilder(with_pip=True).create(environment)
        scripts = environment / ("Scripts" if os.name == "nt" else "bin")
        python = scripts / ("python.exe" if os.name == "nt" else "python")
        run([str(python), "-m", "pip", "install", "--no-index", str(wheel)])
        probe = run(
            [
                str(python),
                "-c",
                (
                    "import asyncio;"
                    "from browser_agent.runtime import resolve_executable;"
                    "print(asyncio.run(resolve_executable()))"
                ),
            ]
        )
        executable = Path(probe.stdout.strip())
        self_test = run([str(executable), "--sdk-self-test-json"])
        expected = {
            "sharp": True,
            "tesseract": True,
            "tiktoken": True,
            "pdf": True,
            "docx": True,
            "xlsx": True,
        }
        if json.loads(self_test.stdout) != expected:
            raise RuntimeError(f"Unexpected self-test output: {self_test.stdout}")

    print(f"Python SDK wheel verified for {platform}.")


if __name__ == "__main__":
    main()
