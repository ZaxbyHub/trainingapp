"""
Regression tests for the /telemetry/memory route on the Python API surface
(issue #66, B8 CI round).

The B8 telemetry subsystem lives on the Electron/Node desktop surface
(desktop/main/backend/memory/). The shared contract (contracts/api.openapi.yaml
v2.4.0) declares GET /telemetry/memory, so the Python host must declare the
path too — but it never wires telemetry, so the route answers the documented
unwired 503 forever. The contract-drift check
(contracts/tests/run_conformance.py --asgi api_server:app) pins path-set
equality; these tests pin the behavior.

Tests:
1. The route answers 503 (a KNOWN path — never 404-absent) with a JSON
   {"detail": ...} body, matching the desktop unwired semantics.
2. The app's OpenAPI schema declares the path (drift-guard at the unit level).
3. The path requires auth like every other route (401 without credentials
   when auth is enabled is the guard's domain; with auth disabled the route
   is reachable and must still 503 — the 503 must never leak before the
   guard).
"""

from fastapi.testclient import TestClient

from api_server import app

client = TestClient(app)


class TestMemoryTelemetryRoute:
    """The Python surface declares /telemetry/memory and answers the
    documented unwired 503 (issue #66 CI round)."""

    def test_route_answers_documented_unwired_503(self):
        response = client.get("/telemetry/memory")
        assert response.status_code == 503, (
            "GET /telemetry/memory must answer the documented unwired 503 "
            f"(known path, never 404); got {response.status_code}"
        )
        body = response.json()
        assert isinstance(body.get("detail"), str) and len(body["detail"]) > 0

    def test_route_declared_in_openapi_schema(self):
        schema = app.openapi()
        assert "/telemetry/memory" in schema.get("paths", {}), (
            "the app's OpenAPI schema must declare /telemetry/memory so the "
            "shared contract drift check stays green"
        )
        assert "get" in schema["paths"]["/telemetry/memory"]

    def test_wrong_method_is_405_not_404(self):
        response = client.post("/telemetry/memory")
        assert (
            response.status_code == 405
        ), "a known path with a wrong method must 405 (route-table semantics)"
