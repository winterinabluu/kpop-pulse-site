from __future__ import annotations

import re
import sys
from pathlib import Path


SENSITIVE_FILENAMES = {
    ".npmrc",
    ".pypirc",
    "credentials",
    "credentials.json",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
}
SENSITIVE_SUFFIXES = {".env", ".key", ".p12", ".pem", ".pfx"}
SENSITIVE_PATTERNS = {
    "Google API key": re.compile(r"AIza[0-9A-Za-z_-]{35}"),
    "GitHub token": re.compile(r"(?:gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{30,})"),
    "OpenAI-style key": re.compile(r"sk-[0-9A-Za-z_-]{20,}"),
    "AWS access key": re.compile(r"(?:AKIA|ASIA)[0-9A-Z]{16}"),
    "Slack token": re.compile(r"xox[baprs]-[0-9A-Za-z-]{20,}"),
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----"),
    "JWT": re.compile(r"eyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}"),
    "credentialed URL": re.compile(r"https?://[^\s/:@]+:[^\s/@]+@", re.IGNORECASE),
    "bearer credential": re.compile(r"\bBearer\s+[0-9A-Za-z._~+/=-]{16,}", re.IGNORECASE),
    "sensitive query parameter": re.compile(
        r"[?&](?:api[_-]?key|key|token|access_token|secret|signature|sig|auth)=[^&#\s]{8,}",
        re.IGNORECASE,
    ),
    "assigned secret": re.compile(
        r"[\"']?(?:api[_-]?key|token|secret|password|passwd)[\"']?\s*[:=]\s*"
        r"(?:[\"'][^\"']{8,}[\"']|[^\s,;}{]{8,})",
        re.IGNORECASE,
    ),
    "private endpoint": re.compile(
        r"(?:\blocalhost\b|(?<!\d)(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
        r"192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?!\d))",
        re.IGNORECASE,
    ),
    "internal hostname": re.compile(r"\b[0-9a-z.-]+\.(?:corp|internal|lan|local)\b", re.IGNORECASE),
    "UNC path": re.compile(r"\\\\[0-9a-z._-]+\\", re.IGNORECASE),
}


def scan_text(text: str) -> list[str]:
    return [name for name, pattern in SENSITIVE_PATTERNS.items() if pattern.search(text)]


def iter_files(paths: list[Path]):
    for path in paths:
        if path.is_file():
            yield path
        elif path.is_dir():
            yield from (candidate for candidate in path.rglob("*") if candidate.is_file())
        else:
            raise FileNotFoundError(path)


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python scripts/check_public_artifact.py <path> [<path> ...]", file=sys.stderr)
        return 2

    failures: list[tuple[Path, str]] = []
    for path in iter_files([Path(value) for value in sys.argv[1:]]):
        name = path.name.lower()
        if (
            name in SENSITIVE_FILENAMES
            or name == ".env"
            or name.startswith(".env.")
            or path.suffix.lower() in SENSITIVE_SUFFIXES
        ):
            failures.append((path, "sensitive file name"))
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        failures.extend((path, rule) for rule in scan_text(text))

    if failures:
        for path, rule in failures:
            print(f"Sensitive-data check failed: {path} ({rule})", file=sys.stderr)
        return 1

    print("Public artifact sensitive-data check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
