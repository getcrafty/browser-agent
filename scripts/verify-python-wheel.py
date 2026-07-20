from __future__ import annotations

import hashlib
import json
import os
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


def main() -> None:
    if len(sys.argv) != 3:
        raise RuntimeError(
            "Usage: verify-python-wheel <browser-agent.whl> <platform>"
        )
    wheel = Path(sys.argv[1]).resolve()
    platform = sys.argv[2]
    expected_wheel_platform = os.environ.get(
        "BROWSER_AGENT_WHEEL_PLATFORM_TAG"
    )
    if (
        expected_wheel_platform
        and not wheel.name.endswith(f"-{expected_wheel_platform}.whl")
    ):
        raise RuntimeError(
            f"Wheel has the wrong platform tag: {wheel.name}; "
            f"expected {expected_wheel_platform}"
        )
    suffix = ".exe" if platform.startswith("win32-") else ""
    executable_entry = (
        f"browser_agent/bin/{platform}/browser-agent{suffix}"
    )
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
        if executable_entry not in names:
            raise RuntimeError(
                f"Wheel does not contain {executable_entry}: {wheel}"
            )
        if not platform.startswith("win32-"):
            mode = archive.getinfo(executable_entry).external_attr >> 16
            if mode & 0o111 == 0:
                raise RuntimeError(
                    f"Wheel executable lacks execute permissions: {oct(mode)}"
                )

    with tempfile.TemporaryDirectory(
        prefix="browser-agent-python-wheel-"
    ) as directory:
        environment = Path(directory) / "venv"
        venv.EnvBuilder(with_pip=True).create(environment)
        scripts = environment / ("Scripts" if os.name == "nt" else "bin")
        python = scripts / ("python.exe" if os.name == "nt" else "python")
        run(
            [
                str(python),
                "-m",
                "pip",
                "install",
                "--no-index",
                str(wheel),
            ]
        )
        probe = run(
            [
                str(python),
                "-c",
                (
                    "from browser_agent.runtime import bundled_executable;"
                    "print(bundled_executable())"
                ),
            ]
        )
        executable = Path(probe.stdout.strip())
        if not executable.is_file():
            raise RuntimeError(f"Installed executable is missing: {executable}")
        root = Path(__file__).resolve().parents[1]
        tested_executable = (
            root
            / "sdk"
            / "python-sdk"
            / "src"
            / "browser_agent"
            / "bin"
            / platform
            / f"browser-agent{suffix}"
        )
        installed_digest = hashlib.sha256(executable.read_bytes()).digest()
        tested_digest = hashlib.sha256(
            tested_executable.read_bytes()
        ).digest()
        if installed_digest != tested_digest:
            raise RuntimeError(
                "Wheel executable differs from the tested binary"
            )
        self_test = run([str(executable), "--sdk-self-test-json"])
        expected = {
            "sharp": True,
            "tesseract": True,
            "pdf": True,
            "docx": True,
            "xlsx": True,
        }
        if json.loads(self_test.stdout) != expected:
            raise RuntimeError(f"Unexpected self-test output: {self_test.stdout}")
        diagnostics = self_test.stderr.lower()
        if (
            "cannot find module" in diagnostics
            or "cannot load" in diagnostics
            or "native binding" in diagnostics
        ):
            raise RuntimeError(
                f"Wheel executable emitted dependency errors:\n{self_test.stderr}"
            )

    print(f"Python SDK wheel verified for {platform}.")


if __name__ == "__main__":
    main()
