"""Canvas export and Office PDF previews (plan 44, Phase 4.5) — the agents service's half.

The sandbox runner is an ``httpx.MockTransport`` speaking its contract; the
document store is a small fake (the version rules are pinned against Postgres
in ``test_conversation_documents.py``). Pinned:

* the commands are constants: no user text (a document, its title, its path,
  an upload's name) ever reaches the command — only file content does, under
  fixed names; the reference .docx travels as an input; only the job's own
  output file is taken back;
* the download's name: the first H1 (ATX or setext, outside code fences), else
  the file name, cut down to letters / digits / a little punctuation;
* ``md`` never touches the runner; docx / pdf go through it as
  ``platform-export``; the version asked for (or the latest) is the input;
* the error mapping: execution off / runner down / busy → 503
  ``sandbox_unavailable``, a timeout (the box's or the client's) → 504, a
  failed run → 502, a missing document → 404, a bad path / format → 422;
* the preview route: allowed extensions only, 413 over the input cap, the
  runner call as ``platform-preview``; both routes are internal-only.
"""
from __future__ import annotations

import base64
import importlib
import json
import zipfile
from datetime import UTC, datetime
from io import BytesIO
from urllib.parse import unquote

import httpx
import pytest

pytestmark = pytest.mark.asyncio

RUNNER_URL = "https://sandbox_runner:8090"
BRIEF = "/conversation/output/brief.md"
EXPORT = "/users/u1/conversations/c1/documents/export"
PREVIEW = "/users/u1/conversations/c1/office-preview"
HOSTILE = "# $(touch /tmp/pwned) `id` ; rm -rf / 'x' \"y\"\n\nBody with $HOME and | pipes."


def _commands():
    return importlib.import_module("harness.conversions.commands")


def _client_mod():
    return importlib.import_module("harness.conversions.client")


def _export():
    return importlib.import_module("utils.document_export")


def _enable(agents_service) -> None:
    fs = agents_service.settings_module.settings.filesystem
    fs.sandbox_execution_enabled = True
    fs.sandbox_runner_url = RUNNER_URL


class _Runner:
    """A scripted runner: records every request, answers from a queue."""

    def __init__(self, *answers):
        self.requests: list[httpx.Request] = []
        self._answers = list(answers)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        answer = self._answers.pop(0) if len(self._answers) > 1 else self._answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)

    def bodies(self) -> list[dict]:
        return [json.loads(r.content) for r in self.requests]


def _ok(output: str, data: bytes = b"%PDF-1.7 fake", **overrides) -> httpx.Response:
    body = {"exit_code": 0, "stdout": "", "stderr": "", "truncated": False, "duration_ms": 900,
            "killed_reason": None,
            "files": [{"path": output, "content_b64": base64.b64encode(data).decode(), "size": len(data)}]}
    body.update(overrides)
    return httpx.Response(200, json=body)


class _FakeStore:
    """The two reads export uses, over one document with two versions."""

    def __init__(self, versions: dict[int, str]):
        self._versions = versions
        self.calls: list[tuple] = []

    def _row(self, version: int):
        versions = importlib.import_module("harness.conversation_files.versions")
        text = self._versions[version]
        return versions.DocumentVersion(
            path=BRIEF, version=version, author="agent", base_version=None, size_bytes=len(text.encode()),
            sha256="0" * 64, created_at=datetime(2026, 11, 19, tzinfo=UTC), content=text,
        )

    async def latest(self, user_id, conversation_id, path):
        self.calls.append(("latest", user_id, conversation_id, path))
        return self._row(max(self._versions))

    async def get_version(self, user_id, conversation_id, path, version):
        self.calls.append(("get_version", user_id, conversation_id, path, version))
        if version not in self._versions:
            raise importlib.import_module("harness.conversation_files.versions").DocumentNotFound(path)
        return self._row(version)


@pytest.fixture
def store(agents_service, monkeypatch):
    fake = _FakeStore({1: "# Old title\n\nv1", 2: "# Αναφορά: Q3/Q4 «σχέδιο»\n\n| a | b |\n|---|---|\n| 1 | 2 |\n"})
    monkeypatch.setattr(_export(), "_store", lambda: fake)
    return fake


@pytest.fixture
def runner_via(agents_service, monkeypatch):
    """Route the export utils' runner calls through a given ``_Runner``."""

    def install(runner: _Runner) -> _Runner:
        real = _client_mod().run_conversion

        async def through_mock(job, files, **kwargs):
            return await real(job, files, transport=runner.transport, **kwargs)

        monkeypatch.setattr(_export(), "run_conversion", through_mock)
        return runner

    return install


# ---------------------------------------------------------------------------
# The fixed commands
# ---------------------------------------------------------------------------
async def test_the_export_commands_are_pinned_constants(agents_service):
    commands = _commands()
    docx, pdf = commands.export_job("docx"), commands.export_job("pdf")

    assert docx.command == (
        "set -eu\n"
        "pandoc --from=gfm --to=docx --reference-doc=/conversation/input/reference.docx "
        "--output=/conversation/output/document.docx /conversation/input/document.md"
    )
    assert pdf.command == (
        "set -eu\n"
        "pandoc --from=gfm --to=docx --reference-doc=/conversation/input/reference.docx "
        "--output=/tmp/document.docx /conversation/input/document.md\n"
        "soffice --headless --norestore --convert-to pdf --outdir /conversation/output "
        "/tmp/document.docx >/dev/null"
    )
    assert docx.inputs == pdf.inputs == ("input/document.md", "input/reference.docx")
    assert (docx.output, pdf.output) == ("output/document.docx", "output/document.pdf")


@pytest.mark.parametrize("ext", ["docx", "xlsx", "pptx", "odt", "ods", "odp"])
async def test_the_preview_command_is_a_constant_per_extension(agents_service, ext):
    job = _commands().office_preview_job(ext)

    assert job.command == (
        "set -eu\nsoffice --headless --norestore --convert-to pdf --outdir /conversation/output "
        f"/conversation/input/source.{ext} >/dev/null"
    )
    assert job.inputs == (f"input/source.{ext}",) and job.output == "output/source.pdf"


@pytest.mark.parametrize("bad", ["doc", "xlsm", "ppt", "docx; rm -rf /", "../x", ""])
async def test_anything_outside_the_closed_sets_is_refused(agents_service, bad):
    with pytest.raises(ValueError):
        _commands().office_preview_job(bad)
    with pytest.raises(ValueError):
        _commands().export_job(bad)


async def test_the_reference_docx_names_fonts_that_cover_greek(agents_service):
    reference = _commands().REFERENCE_DOCX_PATH.read_bytes()
    with zipfile.ZipFile(BytesIO(reference)) as z:
        theme = z.read("word/theme/theme1.xml").decode()
        styles = z.read("word/styles.xml").decode()
    assert '<a:latin typeface="Calibri"' in theme and "Cambria" not in theme
    assert "Courier New" in styles and "Consolas" not in styles
    assert "<w:tblBorders>" in styles


async def test_user_text_reaches_the_box_only_as_file_content(agents_service, store, runner_via):
    _enable(agents_service)
    store._versions[3] = HOSTILE
    runner = runner_via(_Runner(_ok("output/document.pdf")))

    exported = await _export().export_document("u1", "c1", BRIEF, None, "pdf")

    [body] = runner.bodies()
    assert body["command"] == _commands().export_job("pdf").command
    for fragment in ("touch", "$(", "rm -rf", "brief", "pwned"):
        assert fragment not in body["command"]
    assert body["agent_slug"] == "platform-export"
    assert (body["user_id"], body["conversation_id"]) == ("u1", "c1")
    assert body["timeout_seconds"] == 60
    files = {f["path"]: base64.b64decode(f["content_b64"]) for f in body["files"]}
    assert files["input/document.md"].decode() == HOSTILE
    assert files["input/reference.docx"] == _commands().REFERENCE_DOCX_PATH.read_bytes()
    assert set(files) == {"input/document.md", "input/reference.docx"}
    assert exported.content == b"%PDF-1.7 fake" and exported.version == 3


# ---------------------------------------------------------------------------
# The download's name
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(("markdown", "name", "expected"), [
    ("# Αναφορά Q3\n\ntext", "brief.md", "Αναφορά Q3.docx"),
    ("intro\n\n# **Bold** [link](https://x.y) `code`\n", "brief.md", "Bold link code.docx"),
    ("```\n# not a heading\n```\n\n# Real one\n", "brief.md", "Real one.docx"),
    ("Setext title\n============\n\ntext", "brief.md", "Setext title.docx"),
    ("## only h2\n\ntext", "quarterly-plan.md", "quarterly-plan.docx"),
    ("# ../../etc/passwd\n", "brief.md", "etc passwd.docx"),
    ('# a/b\\c:d*e?"f"<g>|h\x07\n', "brief.md", "a b c de f g h.docx"),
    ("# ...\n", "...md", "document.docx"),
    ("no heading", "notes/σημειώσεις.md", "σημειώσεις.docx"),
])
async def test_the_filename_is_the_first_h1_cut_down_to_safe_characters(agents_service, markdown, name, expected):
    assert _export().export_filename(markdown, name, "docx") == expected


async def test_a_long_title_is_capped(agents_service):
    name = _export().export_filename("# " + "ω" * 300, "brief.md", "pdf")
    assert name == "ω" * _export().MAX_TITLE_CHARS + ".pdf"


# ---------------------------------------------------------------------------
# The runner call and its failures
# ---------------------------------------------------------------------------
async def _convert(runner: _Runner):
    job = _commands().export_job("docx")
    return await _client_mod().run_conversion(
        job, {"input/document.md": b"# x", "input/reference.docx": b"ref"},
        user_id="u1", conversation_id="c1", purpose="platform-export", transport=runner.transport,
    )


async def test_without_execution_the_box_is_unavailable_and_never_called(agents_service):
    runner = _Runner(_ok("output/document.docx"))
    agents_service.settings_module.settings.filesystem.sandbox_runner_url = RUNNER_URL
    agents_service.settings_module.settings.filesystem.sandbox_execution_enabled = False

    with pytest.raises(_client_mod().ConversionUnavailable):
        await _convert(runner)
    assert runner.requests == []


@pytest.mark.parametrize(("answer", "error"), [
    (httpx.ConnectError("down"), "ConversionUnavailable"),
    (httpx.Response(503, json={"detail": "x"}), "ConversionUnavailable"),
    (httpx.Response(429, json={"detail": "busy"}), "ConversionUnavailable"),
    (httpx.Response(500), "ConversionUnavailable"),
    (httpx.ReadTimeout("slow"), "ConversionTimeout"),
    (_ok("output/document.docx", killed_reason="timeout", exit_code=None), "ConversionTimeout"),
    (_ok("output/document.docx", killed_reason="memory", exit_code=None), "ConversionFailed"),
    (_ok("output/document.docx", exit_code=64), "ConversionFailed"),
    (_ok("output/elsewhere.docx"), "ConversionFailed"),
    (_ok("output/document.docx", data=b""), "ConversionFailed"),
    (httpx.Response(422, json={"detail": "bad"}), "ConversionFailed"),
    (httpx.Response(200, text="not json"), "ConversionFailed"),
])
async def test_runner_failures_are_typed(agents_service, answer, error):
    _enable(agents_service)
    with pytest.raises(getattr(_client_mod(), error)):
        await _convert(_Runner(answer))


async def test_only_the_jobs_own_output_is_taken(agents_service):
    _enable(agents_service)
    stray = {"path": "output/evil.docx", "content_b64": base64.b64encode(b"evil").decode(), "size": 4}
    answer = _ok("output/document.docx", data=b"PK real")
    body = json.loads(answer.content)
    body["files"].insert(0, stray)

    data = await _convert(_Runner(httpx.Response(200, json=body)))

    assert data == b"PK real"


async def test_an_oversized_input_is_refused_before_the_call(agents_service):
    _enable(agents_service)
    runner = _Runner(_ok("output/source.pdf"))
    with pytest.raises(_client_mod().ConversionFailed):
        await _client_mod().run_conversion(
            _commands().office_preview_job("docx"),
            {"input/source.docx": b"x" * (_client_mod().MAX_INPUT_BYTES + 1)},
            user_id="u1", conversation_id="c1", purpose="platform-preview", transport=runner.transport,
        )
    assert runner.requests == []


# ---------------------------------------------------------------------------
# The routes
# ---------------------------------------------------------------------------
async def test_md_is_served_as_stored_without_the_box(client, internal_headers, agents_service, store, runner_via):
    _enable(agents_service)
    runner = runner_via(_Runner(_ok("output/document.docx")))

    resp = await client.post(EXPORT, headers=internal_headers, json={"path": BRIEF, "format": "md"})

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "text/markdown; charset=utf-8"
    assert resp.content.decode() == store._versions[2]
    assert unquote(resp.headers["x-export-filename"]) == "Αναφορά Q3 Q4 σχέδιο.md"
    assert resp.headers["x-document-version"] == "2"
    assert runner.requests == []


async def test_a_named_version_is_the_input(client, internal_headers, agents_service, store, runner_via):
    _enable(agents_service)
    runner = runner_via(_Runner(_ok("output/document.docx", data=b"PK docx")))

    resp = await client.post(EXPORT, headers=internal_headers, json={"path": BRIEF, "version": 1, "format": "docx"})

    assert resp.status_code == 200 and resp.content == b"PK docx"
    assert resp.headers["content-type"] == _commands().DOCX_MEDIA_TYPE
    assert unquote(resp.headers["x-export-filename"]) == "Old title.docx"
    [body] = runner.bodies()
    files = {f["path"]: base64.b64decode(f["content_b64"]) for f in body["files"]}
    assert files["input/document.md"] == b"# Old title\n\nv1"
    assert ("get_version", "u1", "c1", BRIEF, 1) in store.calls


@pytest.mark.parametrize(("answer", "status_code", "detail"), [
    (httpx.ConnectError("down"), 503, "sandbox_unavailable"),
    (httpx.ReadTimeout("slow"), 504, "conversion_timeout"),
    (_ok("output/document.pdf", exit_code=1), 502, "conversion_failed"),
])
async def test_export_errors_map_to_statuses(client, internal_headers, agents_service, store, runner_via,
                                             answer, status_code, detail):
    _enable(agents_service)
    runner_via(_Runner(answer))

    resp = await client.post(EXPORT, headers=internal_headers, json={"path": BRIEF, "format": "pdf"})

    assert resp.status_code == status_code
    assert resp.json()["detail"] == detail


async def test_export_without_a_runner_is_a_503(client, internal_headers, agents_service, store):
    agents_service.settings_module.settings.filesystem.sandbox_runner_url = ""

    resp = await client.post(EXPORT, headers=internal_headers, json={"path": BRIEF, "format": "docx"})

    assert resp.status_code == 503 and resp.json()["detail"] == "sandbox_unavailable"


@pytest.mark.parametrize("body", [
    {"path": BRIEF, "format": "html"},
    {"path": BRIEF, "format": "pdf", "version": 0},
    {"path": "/conversation/input/brief.md", "format": "md"},
    {"path": BRIEF, "format": "md", "command": "id"},
])
async def test_bad_requests_are_422(client, internal_headers, agents_service, store, body):
    resp = await client.post(EXPORT, headers=internal_headers, json=body)
    assert resp.status_code == 422


async def test_a_missing_version_is_404(client, internal_headers, agents_service, store):
    resp = await client.post(EXPORT, headers=internal_headers, json={"path": BRIEF, "version": 9, "format": "md"})
    assert resp.status_code == 404


async def test_the_routes_are_internal_only(client, agents_service, store):
    export = await client.post(EXPORT, json={"path": BRIEF, "format": "md"})
    preview = await client.post(PREVIEW, params={"extension": "docx"}, content=b"PK")
    assert export.status_code == 403 and preview.status_code == 403


async def test_the_preview_renders_the_body_in_the_box(client, internal_headers, agents_service, runner_via):
    _enable(agents_service)
    runner = runner_via(_Runner(_ok("output/source.pdf", data=b"%PDF-1.7 preview")))

    resp = await client.post(PREVIEW, headers=internal_headers, params={"extension": "xlsx"}, content=b"PK xlsx")

    assert resp.status_code == 200 and resp.content == b"%PDF-1.7 preview"
    assert resp.headers["content-type"] == "application/pdf"
    [body] = runner.bodies()
    assert body["agent_slug"] == "platform-preview"
    assert body["command"] == _commands().office_preview_job("xlsx").command
    assert [f["path"] for f in body["files"]] == ["input/source.xlsx"]
    assert base64.b64decode(body["files"][0]["content_b64"]) == b"PK xlsx"


@pytest.mark.parametrize("ext", ["doc", "html", "docx;id"])
async def test_the_preview_refuses_other_types(client, internal_headers, agents_service, ext):
    resp = await client.post(PREVIEW, headers=internal_headers, params={"extension": ext}, content=b"PK")
    assert resp.status_code == 422


async def test_the_preview_refuses_an_empty_or_oversized_body(client, internal_headers, agents_service, monkeypatch):
    monkeypatch.setattr(importlib.import_module("router.document_export"), "MAX_INPUT_BYTES", 4)

    empty = await client.post(PREVIEW, headers=internal_headers, params={"extension": "docx"}, content=b"")
    big = await client.post(PREVIEW, headers=internal_headers, params={"extension": "docx"}, content=b"12345")

    assert empty.status_code == 422 and big.status_code == 413
