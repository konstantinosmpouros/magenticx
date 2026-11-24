"""Which browser origins the bridge trusts: CORS, in production too. The live
streams are plain HTTP (SSE), so the same CORS guards them: a page on a sibling
subdomain is sent the user's cookie but may never read a stream's response."""

from __future__ import annotations

from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from pydantic import ValidationError

import core.settings as settings_module
from utils.validators import validate_userId
from core.settings import (
    AppSettings,
    CorsSettings,
    Settings,
    SigningSettings,
    _is_public_https_origin,
    settings,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
EVIL = "https://evil.magenticx.com"
STREAMS = [
    "/v1/tasks/{user}/task-1/events",
    "/v1/conversations/{user}/conv-1/events",
    "/v1/inference/runs/{user}/run-1/events",
]


# --- the live streams ---------------------------------------------------------------

@pytest.mark.parametrize("path", STREAMS)
async def test_a_foreign_origin_is_never_allowed_to_read_a_stream(client, seeded_user, path):
    response = await client.get(path.format(user=seeded_user.id), headers={"origin": EVIL})
    assert response.headers.get("access-control-allow-origin") != EVIL


@pytest.mark.parametrize("path", STREAMS)
async def test_a_stream_needs_a_session(app, seeded_user, path, monkeypatch):
    # The real session check, not the suite's signed-in stand-in.
    monkeypatch.delitem(app.dependency_overrides, validate_userId)
    # No `with`: the app's lifespan (migrations, loops) must not run here.
    client = TestClient(app)
    response = client.get(path.format(user=seeded_user.id), headers={"origin": "http://localhost:8050"})
    assert response.status_code == 401


# --- production CORS ----------------------------------------------------------------

@pytest.mark.parametrize("origin, public", [
    ("https://agents.magenticx.com", True),
    ("https://agents.magenticx.com:8443", True),
    ("http://agents.magenticx.com", False),
    ("http://localhost:8050", False),
    ("https://localhost", False),
    ("https://127.0.0.1:8050", False),
    ("not-an-origin", False),
])
def test_public_https_origin(origin, public):
    assert _is_public_https_origin(origin) is public


def _kms_signing(tmp_path: Path) -> SigningSettings:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode("ascii")
    return SigningSettings(
        _env_file=None,
        SESSION_SIGNING_BACKEND="kms",
        SESSION_SIGNING_ACTIVE_KID=100,
        SESSION_SIGNING_KEYS="100:ocid1.keyversion.oc1..active",
        SESSION_SIGNING_PUBLIC_KEYS_DIR=str(tmp_path),
        OCI_KMS_CRYPTO_ENDPOINT="https://test-crypto.kms.eu-frankfurt-1.oraclecloud.com",
        OCI_KMS_KEY_ID="ocid1.key.oc1..signing",
        OCI_USER_OCID="ocid1.user.oc1..signer",
        OCI_TENANCY_OCID="ocid1.tenancy.oc1..tenancy",
        OCI_API_KEY_FINGERPRINT=":".join(["ab"] * 16),
        OCI_REGION="eu-frankfurt-1",
        oci_api_key=pem,
    )


def test_production_refuses_the_localhost_defaults(tmp_path):
    with pytest.raises(ValidationError, match="CORS_ALLOWED_ORIGINS must list only https origins"):
        Settings(
            app=AppSettings(_env_file=None, APP_ENV="production"),
            signing=_kms_signing(tmp_path),
            cors=CorsSettings(_env_file=None),
        )


@pytest.mark.parametrize("raw, expected", [
    ("https://agents.magenticx.com", ("https://agents.magenticx.com",)),  # what Dennis sets
    ("https://a.example, https://b.example", ("https://a.example", "https://b.example")),
    ('["https://a.example", "https://b.example"]', ("https://a.example", "https://b.example")),
])
def test_cors_origins_are_read_from_the_environment(monkeypatch, raw, expected):
    # Set through the env, as in production: a tuple env value used to be
    # JSON-decoded first, so a plain origin crashed the bridge at boot.
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", raw)
    monkeypatch.setenv("CORS_ALLOW_METHODS", "GET,POST")
    cors = CorsSettings(_env_file=None)
    assert cors.allowed_origins == expected
    assert cors.allow_methods == ("GET", "POST")


def test_development_keeps_the_localhost_defaults():
    assert settings_module.settings.app.env in {"development", "test"}
    assert "http://localhost:8050" in CorsSettings(_env_file=None).allowed_origins


def test_dennis_trusts_only_the_app_origin():
    compose = (REPO_ROOT / "magenticx" / "docker-compose-denis.yaml").read_text(encoding="utf-8")
    start = compose.index("\n  dialogue_bridge:")
    bridge = compose[start:compose.index("\n  agentic_ui:", start)]
    assert "- CORS_ALLOWED_ORIGINS=https://agents.magenticx.com\n" in bridge
