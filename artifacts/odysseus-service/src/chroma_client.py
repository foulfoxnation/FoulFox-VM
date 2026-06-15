"""
chroma_client.py

Singleton ChromaDB client.

Default: an EMBEDDED, on-disk store (chromadb.PersistentClient) under
DATA_DIR/chroma — no separate service, no port, persists across reboots. This
matches FoulFox's "self-contained appliance" model where all mutable state
lives under ODYSSEUS_DATA_DIR.

Opt-in: a remote ChromaDB HTTP service (chromadb.HttpClient). Selected when any
of these is set:
  - CHROMADB_HOST            (host of a running ChromaDB service)
  - CHROMADB_MODE=http       (or "server" / "remote")
  - CHROMADB_SERVER=true     (1/true/yes/on)
Otherwise the embedded store is used.
"""

import os
import socket
import logging

from src.constants import CHROMA_DIR

logger = logging.getLogger(__name__)

_client = None

# A short connect probe so an unreachable ChromaDB *service* fails fast instead
# of blocking on the OS connection timeout (~30-60s, WinError 10060 on Windows),
# which otherwise stalls app startup. Tunable via CHROMADB_CONNECT_TIMEOUT.
# Only used by the HTTP branch — the embedded store opens locally.
_CONNECT_TIMEOUT = float(os.getenv("CHROMADB_CONNECT_TIMEOUT", "2.0"))

_TRUTHY = {"1", "true", "yes", "on"}


def _use_http() -> bool:
    """Return True when an external ChromaDB HTTP service is configured."""
    if os.getenv("CHROMADB_HOST"):
        return True
    if os.getenv("CHROMADB_MODE", "").strip().lower() in ("http", "server", "remote"):
        return True
    if os.getenv("CHROMADB_SERVER", "").strip().lower() in _TRUTHY:
        return True
    return False


def _port_open(host: str, port: int, timeout: float = None) -> bool:
    """Return True if a TCP connection to host:port succeeds within timeout."""
    try:
        with socket.create_connection((host, port), timeout=timeout or _CONNECT_TIMEOUT):
            return True
    except OSError:
        return False


def _import_chromadb():
    try:
        import chromadb
    except ImportError as e:
        raise RuntimeError(
            "ChromaDB integration is not installed. Install the optional "
            "dependency with: pip install chromadb"
        ) from e
    return chromadb


def _make_http_client():
    """Create + health-check a remote ChromaDB HTTP client."""
    chromadb = _import_chromadb()
    host = os.getenv("CHROMADB_HOST", "localhost")
    port = int(os.getenv("CHROMADB_PORT", "8100"))

    if not _port_open(host, port):
        raise RuntimeError(
            f"ChromaDB is not reachable at {host}:{port}. Start the ChromaDB "
            f"service or set CHROMADB_HOST / CHROMADB_PORT to point at a running "
            f"instance (or unset them to use the default embedded store)."
        )

    client = chromadb.HttpClient(host=host, port=port)
    # Health check before caching — if the port is open but the service isn't
    # healthy yet (e.g. still starting), don't poison the singleton with a dead
    # client; leave _client unset so the next call retries.
    client.heartbeat()
    logger.info(f"ChromaDB connected (http): {host}:{port}")
    return client


def _make_embedded_client():
    """Create an embedded, on-disk ChromaDB client under DATA_DIR/chroma."""
    chromadb = _import_chromadb()
    os.makedirs(CHROMA_DIR, exist_ok=True)
    client = chromadb.PersistentClient(path=CHROMA_DIR)
    logger.info(f"ChromaDB ready (embedded): {CHROMA_DIR}")
    return client


def get_chroma_client():
    """Get or create the singleton ChromaDB client.

    Embedded (PersistentClient) by default; HTTP when explicitly configured.
    Raises RuntimeError with a clear install hint if the `chromadb` package is
    not installed, or if an explicitly-configured HTTP service is unreachable.
    """
    global _client
    if _client is not None:
        return _client

    _client = _make_http_client() if _use_http() else _make_embedded_client()
    return _client


def reset_client():
    """Reset the singleton (e.g. after config change)."""
    global _client
    _client = None
