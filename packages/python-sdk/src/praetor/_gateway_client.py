"""HTTP client for the Architecture V2 Action Gateway."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from typing import Any
from urllib.parse import quote

import httpx

from ._exceptions import map_status_to_error
from ._types import (
    ActionApprovalInput,
    ActionCompensationApprovalInput,
    ActionCompensationApprovalResult,
    ActionCompensationInput,
    ActionCompensationResult,
    ActionEvidenceBundle,
    ActionEvidenceJwks,
    ActionEvidenceVerification,
    ActionSimulation,
    GatewayErrorDetail,
    GovernedAction,
    KillSwitch,
    KillSwitchScope,
    KillSwitchUpdateInput,
    ProposeActionInput,
    ProposeActionResult,
    RequestReconcileResult,
)

_ED25519_P = 2**255 - 19
_ED25519_L = 2**252 + 27742317777372353535851937790883648493
_ED25519_D = (-121665 * pow(121666, _ED25519_P - 2, _ED25519_P)) % _ED25519_P
_ED25519_I = pow(2, (_ED25519_P - 1) // 4, _ED25519_P)
_ED25519_IDENTITY = (0, 1, 1, 0)


def _decode_base64url(value: str) -> bytes:
    if "=" in value:
        raise ValueError("base64url input must be unpadded")
    padded = value + "=" * (-len(value) % 4)
    decoded = base64.b64decode(padded, altchars=b"-_", validate=True)
    if base64.urlsafe_b64encode(decoded).rstrip(b"=").decode() != value:
        raise ValueError("non-canonical base64url input")
    return decoded


def _decode_ed25519_point(value: bytes) -> tuple[int, int, int, int]:
    if len(value) != 32:
        raise ValueError("Ed25519 point must be 32 bytes")
    encoded = int.from_bytes(value, "little")
    sign = encoded >> 255
    y = encoded & ((1 << 255) - 1)
    if y >= _ED25519_P:
        raise ValueError("non-canonical Ed25519 point")
    y2 = y * y % _ED25519_P
    u = (y2 - 1) % _ED25519_P
    v = (_ED25519_D * y2 + 1) % _ED25519_P
    x2 = u * pow(v, _ED25519_P - 2, _ED25519_P) % _ED25519_P
    x = pow(x2, (_ED25519_P + 3) // 8, _ED25519_P)
    if (x * x - x2) % _ED25519_P:
        x = x * _ED25519_I % _ED25519_P
    if (x * x - x2) % _ED25519_P:
        raise ValueError("invalid Ed25519 point")
    if x == 0 and sign:
        raise ValueError("non-canonical Ed25519 point")
    if x & 1 != sign:
        x = _ED25519_P - x
    return (x, y, 1, x * y % _ED25519_P)


def _add_ed25519_points(
    left: tuple[int, int, int, int], right: tuple[int, int, int, int]
) -> tuple[int, int, int, int]:
    x1, y1, z1, t1 = left
    x2, y2, z2, t2 = right
    a = (y1 - x1) * (y2 - x2) % _ED25519_P
    b = (y1 + x1) * (y2 + x2) % _ED25519_P
    c = 2 * _ED25519_D * t1 * t2 % _ED25519_P
    d = 2 * z1 * z2 % _ED25519_P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (
        e * f % _ED25519_P,
        g * h % _ED25519_P,
        f * g % _ED25519_P,
        e * h % _ED25519_P,
    )


def _multiply_ed25519_point(
    point: tuple[int, int, int, int], scalar: int
) -> tuple[int, int, int, int]:
    result = _ED25519_IDENTITY
    addend = point
    while scalar:
        if scalar & 1:
            result = _add_ed25519_points(result, addend)
        addend = _add_ed25519_points(addend, addend)
        scalar >>= 1
    return result


def _equal_ed25519_points(
    left: tuple[int, int, int, int], right: tuple[int, int, int, int]
) -> bool:
    return (left[0] * right[2] - right[0] * left[2]) % _ED25519_P == 0 and (
        left[1] * right[2] - right[1] * left[2]
    ) % _ED25519_P == 0


def _verify_ed25519(public_key: bytes, message: bytes, signature: bytes) -> bool:
    if len(public_key) != 32 or len(signature) != 64:
        return False
    try:
        public_point = _decode_ed25519_point(public_key)
        r_point = _decode_ed25519_point(signature[:32])
    except ValueError:
        return False
    if _equal_ed25519_points(
        _multiply_ed25519_point(public_point, 8), _ED25519_IDENTITY
    ) or _equal_ed25519_points(_multiply_ed25519_point(r_point, 8), _ED25519_IDENTITY):
        return False
    scalar = int.from_bytes(signature[32:], "little")
    if scalar >= _ED25519_L:
        return False
    base_point = _decode_ed25519_point(bytes.fromhex("58" + "66" * 31))
    challenge = (
        int.from_bytes(
            hashlib.sha512(signature[:32] + public_key + message).digest(), "little"
        )
        % _ED25519_L
    )
    expected = _add_ed25519_points(
        r_point, _multiply_ed25519_point(public_point, challenge)
    )
    return _equal_ed25519_points(_multiply_ed25519_point(base_point, scalar), expected)


def _invalid_evidence(code: str, message: str) -> ActionEvidenceVerification:
    return ActionEvidenceVerification(
        valid=False, error=GatewayErrorDetail(code=code, message=message)
    )


def verify_action_evidence(
    receipt: str, jwks: ActionEvidenceJwks | dict[str, Any]
) -> ActionEvidenceVerification:
    """Verify a compact Ed25519 JWS receipt using only the supplied JWKS."""

    try:
        encoded_header, encoded_payload, encoded_signature = receipt.split(".")
        if not encoded_header or not encoded_payload or not encoded_signature:
            raise ValueError("empty compact JWS segment")
        header = json.loads(_decode_base64url(encoded_header))
        if not isinstance(header, dict):
            raise ValueError("JWS header must be an object")  # noqa: TRY004 - ValueError is the documented failure surface here
        if header.get("alg") != "EdDSA" or not isinstance(header.get("kid"), str):
            return _invalid_evidence(
                "EVIDENCE_RECEIPT_INVALID",
                "Evidence receipt requires EdDSA and a key id.",
            )
        key_set = (
            jwks if isinstance(jwks, ActionEvidenceJwks) else ActionEvidenceJwks(**jwks)
        )
        key = next(
            (
                candidate
                for candidate in key_set.keys
                if candidate.kid == header["kid"]
                and (candidate.alg is None or candidate.alg == "EdDSA")
                and (candidate.use is None or candidate.use == "sig")
            ),
            None,
        )
        if key is None:
            return _invalid_evidence(
                "EVIDENCE_KEY_NOT_FOUND", "No matching Ed25519 signing key exists."
            )
        signing_input = f"{encoded_header}.{encoded_payload}".encode()
        if not _verify_ed25519(
            _decode_base64url(key.x),
            signing_input,
            _decode_base64url(encoded_signature),
        ):
            return _invalid_evidence(
                "EVIDENCE_SIGNATURE_INVALID",
                "Evidence receipt signature is invalid.",
            )
        payload = json.loads(_decode_base64url(encoded_payload))
        if not isinstance(payload, dict):
            return _invalid_evidence(
                "EVIDENCE_PAYLOAD_INVALID",
                "Evidence receipt payload must be an object.",
            )
        return ActionEvidenceVerification(valid=True, payload=payload)
    except (ValueError, TypeError, json.JSONDecodeError):
        return _invalid_evidence(
            "EVIDENCE_RECEIPT_INVALID", "Evidence receipt could not be decoded."
        )


class CommanderGatewayClient:
    """Thin HTTP client for /v1/actions governed action endpoints."""

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        timeout: float = 60.0,
    ) -> None:
        self._base_url = (
            base_url
            or os.environ.get("PRAETOR_API_URL")
            or os.environ.get("COMMANDER_API_URL")
            or "http://127.0.0.1:4000"
        ).rstrip("/")
        self._api_key = api_key or os.environ.get("PRAETOR_API_KEY") or os.environ.get("COMMANDER_API_KEY")
        self._http = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=httpx.Timeout(timeout, connect=10.0),
            headers=self._build_headers(),
        )

    async def __aenter__(self) -> CommanderGatewayClient:  # noqa: PYI034 - typing.Self needs Python 3.11
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()

    async def close(self) -> None:
        await self._http.aclose()

    async def simulate_action(self, input: ProposeActionInput) -> ActionSimulation:
        data = await self._request(
            "POST",
            "/v1/actions/simulate",
            json=input.model_dump(by_alias=True),
            headers={"Idempotency-Key": input.idempotency_key},
        )
        return ActionSimulation(**data["simulation"])

    async def propose_action(self, input: ProposeActionInput) -> ProposeActionResult:
        response = await self._http.request(
            "POST",
            "/v1/actions",
            json=input.model_dump(by_alias=True),
            headers={"Idempotency-Key": input.idempotency_key},
        )
        self._raise_for_status(response)
        body = response.json()
        return ProposeActionResult(
            action=GovernedAction(**body["action"]),
            idempotentReplay=bool(body.get("idempotentReplay")),
            accepted=response.status_code == 202,
        )

    async def get_action(self, run_id: str) -> GovernedAction:
        data = await self._request("GET", f"/v1/actions/{quote(run_id, safe='')}")
        return GovernedAction(**data["action"])

    async def approve_action(
        self, run_id: str, input: ActionApprovalInput, *, idempotency_key: str
    ) -> GovernedAction:
        data = await self._request(
            "POST",
            f"/v1/actions/{quote(run_id, safe='')}/approve",
            json=input.model_dump(by_alias=True),
            headers={"Idempotency-Key": idempotency_key},
        )
        return GovernedAction(**data["action"])

    async def request_action_compensation(
        self,
        run_id: str,
        input: ActionCompensationInput,
        *,
        idempotency_key: str,
    ) -> ActionCompensationResult:
        data = await self._request(
            "POST",
            f"/v1/actions/{quote(run_id, safe='')}/compensations",
            json=input.model_dump(by_alias=True),
            headers={"Idempotency-Key": idempotency_key},
        )
        return ActionCompensationResult(**data)

    async def approve_action_compensation(
        self,
        run_id: str,
        authorization_id: str,
        input: ActionCompensationApprovalInput,
        *,
        idempotency_key: str,
    ) -> ActionCompensationApprovalResult:
        data = await self._request(
            "POST",
            f"/v1/actions/{quote(run_id, safe='')}/compensations/{quote(authorization_id, safe='')}/approve",
            json=input.model_dump(by_alias=True),
            headers={"Idempotency-Key": idempotency_key},
        )
        return ActionCompensationApprovalResult(**data)

    async def reject_action(
        self, run_id: str, *, reason: str | None = None, idempotency_key: str
    ) -> GovernedAction:
        body: dict[str, Any] = {}
        if reason is not None:
            body["reason"] = reason
        data = await self._request(
            "POST",
            f"/v1/actions/{quote(run_id, safe='')}/reject",
            json=body,
            headers={"Idempotency-Key": idempotency_key},
        )
        return GovernedAction(**data["action"])

    async def reconcile_action(
        self, run_id: str, *, idempotency_key: str
    ) -> RequestReconcileResult:
        data = await self._request(
            "POST",
            f"/v1/actions/{quote(run_id, safe='')}/reconcile",
            headers={"Idempotency-Key": idempotency_key},
        )
        return RequestReconcileResult(**data)

    async def get_action_evidence(self, run_id: str) -> ActionEvidenceBundle:
        data = await self._request(
            "GET", f"/v1/actions/{quote(run_id, safe='')}/evidence"
        )
        return ActionEvidenceBundle(**data)

    def verify_action_evidence(
        self, receipt: str, jwks: ActionEvidenceJwks | dict[str, Any]
    ) -> ActionEvidenceVerification:
        return verify_action_evidence(receipt, jwks)

    async def list_kill_switches(self) -> list[KillSwitch]:
        data = await self._request("GET", "/v1/actions/kill-switches")
        return [KillSwitch(**item) for item in data["killSwitches"]]

    async def put_kill_switch(
        self,
        scope: KillSwitchScope,
        value: str,
        input: KillSwitchUpdateInput,
        *,
        idempotency_key: str,
    ) -> KillSwitch:
        data = await self._request(
            "PUT",
            f"/v1/actions/kill-switches/{quote(scope, safe='')}/{quote(value, safe='')}",
            json=input.model_dump(by_alias=True, exclude_none=True),
            headers={"Idempotency-Key": idempotency_key},
        )
        return KillSwitch(**data["killSwitch"])

    async def remove_kill_switch(
        self, scope: KillSwitchScope, value: str, *, idempotency_key: str
    ) -> None:
        await self._request(
            "DELETE",
            f"/v1/actions/kill-switches/{quote(scope, safe='')}/{quote(value, safe='')}",
            headers={"Idempotency-Key": idempotency_key},
        )

    def _build_headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self._api_key:
            # AUDIT-D1①: a static Commander API key is sent as X-API-Key.
            # Authorization: Bearer is reserved for JWT access tokens and is
            # rejected by enterprise /v1 JWT middleware (401 INVALID_TOKEN)
            # before API-key authentication can inspect it.
            headers["X-API-Key"] = self._api_key
        return headers

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        response = await self._http.request(method, path, **kwargs)
        self._raise_for_status(response)
        if response.status_code in (204, 205) or response.content == b"":
            return {}
        return response.json()

    @staticmethod
    def _raise_for_status(response: httpx.Response) -> None:
        if response.status_code < 400:
            return
        code = "GATEWAY_REQUEST_FAILED"
        message = response.text
        details: Any | None = None
        try:
            body = response.json()
            detail = body.get("error") if isinstance(body, dict) else None
            if isinstance(detail, dict):
                if isinstance(detail.get("code"), str):
                    code = detail["code"]
                if isinstance(detail.get("message"), str):
                    message = detail["message"]
                details = detail.get("details")
        except ValueError:
            pass
        error = map_status_to_error(response.status_code, message)
        error.status = response.status_code
        error.status_code = response.status_code
        error.code = code
        error.details = details
        error.body = response.text
        raise error


# Canonical PraetorGatewayClient alias
PraetorGatewayClient = CommanderGatewayClient

