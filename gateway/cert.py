"""Self-signed certificate generator for LAN HTTPS testing."""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path

log = logging.getLogger("cert")

CERT_DIR = Path(__file__).resolve().parent.parent / "certs"
CERT_FILE = CERT_DIR / "cert.pem"
KEY_FILE = CERT_DIR / "key.pem"


def ensure_cert(local_ip: str = "192.168.1.1") -> tuple[Path, Path]:
    """Generate a self-signed cert if one doesn't exist. Returns (cert_path, key_path)."""
    CERT_DIR.mkdir(parents=True, exist_ok=True)

    if CERT_FILE.exists() and KEY_FILE.exists():
        log.info("Using existing self-signed cert: %s", CERT_FILE)
        return CERT_FILE, KEY_FILE

    log.info("Generating self-signed cert for %s...", local_ip)

    # OpenSSL config with SAN for the local IP
    conf = (
        f"[req]\n"
        f"distinguished_name = req_dn\n"
        f"x509_extensions = v3_req\n"
        f"prompt = no\n"
        f"[req_dn]\n"
        f"CN = WebRTC Speaker Dev\n"
        f"[v3_req]\n"
        f"subjectAltName = IP:{local_ip}\n"
    )
    conf_path = CERT_DIR / "openssl.cnf"
    conf_path.write_text(conf)

    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", str(KEY_FILE),
            "-out", str(CERT_FILE),
            "-days", "365",
            "-nodes",
            "-config", str(conf_path),
        ],
        check=True,
        capture_output=True,
    )

    log.info("Self-signed cert created: %s", CERT_FILE)
    return CERT_FILE, KEY_FILE
