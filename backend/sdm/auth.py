"""OIDC code + PKCE. Browser cookies contain only opaque, revocable session IDs."""
import base64
from hashlib import sha256
import hmac
import secrets
import threading
import time
from urllib.parse import urlencode, urlsplit

from authlib.oidc.core import CodeIDToken
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
import httpx
from joserfc import jwt
from joserfc.jwk import KeySet
from sqlalchemy import delete, select

from .config import secret
from .store import login_flows, user_sessions

COOKIE = "__Host-sdm-session"
FLOW_COOKIE = "__Host-sdm-login"


def hashed(value):
    return sha256(value.encode()).hexdigest()


def return_path(value):
    # The SPA has one pathname. Keep its deep-link query, never an external redirect.
    if len(value) > 1800 or not value.startswith("/") or "\\" in value or any(ord(c) < 32 for c in value):
        return "/"
    parsed = urlsplit(value)
    return value if not parsed.netloc and not parsed.scheme and parsed.path == "/" and not parsed.fragment else "/"


class BrowserAuth:
    def __init__(self, config, store, client=None, clock=time.time):
        self.config, self.store, self.clock = config, store, clock
        self.client = client or httpx.Client(timeout=10, follow_redirects=False)
        self.cache, self.cache_until, self.retry_at = None, 0, 0
        self.lock = threading.Lock()

    def metadata(self):
        if not self.config:
            raise HTTPException(503, "sso_not_configured")
        with self.lock:
            if self.cache and self.clock() < self.cache_until:
                return self.cache
            if self.clock() < self.retry_at:
                raise HTTPException(503, "sso_unavailable")
            try:
                issuer = self.config.issuer
                origin = urlsplit(issuer).netloc
                response = self.client.get(issuer + ".well-known/openid-configuration")
                response.raise_for_status()
                metadata = response.json()
                if metadata["issuer"] != issuer:
                    raise ValueError("issuer mismatch")
                for field in ["authorization_endpoint", "token_endpoint", "jwks_uri"]:
                    url = urlsplit(metadata[field])
                    if url.scheme != "https" or url.netloc != origin or url.username or url.password or url.fragment:
                        raise ValueError("OIDC endpoint outside configured origin")
                response = self.client.get(metadata["jwks_uri"])
                response.raise_for_status()
                metadata["keys"] = KeySet.import_key_set(response.json())
                self.cache, self.cache_until = metadata, self.clock() + 300
                return metadata
            except Exception:
                self.retry_at = self.clock() + 30
                raise HTTPException(503, "sso_unavailable") from None

    def identity(self, request):
        token = request.cookies.get(COOKIE, "")
        if not self.config or len(token) != 64:
            return None
        with self.store.engine.connect() as conn:
            row = conn.execute(select(user_sessions).where(user_sessions.c.token_hash == hashed(token),
                user_sessions.c.expires_at > self.clock())).mappings().first()
        return dict(row["user"]) if row else None

    def login(self, request, next_path):
        metadata = self.metadata()
        state, browser, verifier, nonce = (secrets.token_urlsafe(48) for _ in range(4))
        now = self.clock()
        with self.store.engine.begin() as conn:
            conn.execute(delete(login_flows).where(login_flows.c.expires_at <= now))
            conn.execute(delete(user_sessions).where(user_sessions.c.expires_at <= now))
            # A new attempt in this browser replaces its outstanding flow.
            old = request.cookies.get(FLOW_COOKIE, "")
            if old:
                conn.execute(delete(login_flows).where(login_flows.c.browser_hash == hashed(old)))
            conn.execute(login_flows.insert().values(state_hash=hashed(state), browser_hash=hashed(browser),
                verifier=verifier, nonce=nonce, return_to=return_path(next_path), expires_at=now + 300))
        challenge = base64.urlsafe_b64encode(sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        response = RedirectResponse(metadata["authorization_endpoint"] + "?" + urlencode({
            "client_id": secret(self.config.client_id_env), "response_type": "code", "scope": "openid profile email",
            "redirect_uri": self.config.public_url + "/auth/callback", "state": state, "nonce": nonce,
            "code_challenge": challenge, "code_challenge_method": "S256", "response_mode": "query",
        }), status_code=302)
        response.set_cookie(FLOW_COOKIE, browser, max_age=300, secure=True, httponly=True, samesite="lax", path="/")
        return response

    def callback(self, request):
        state, code = request.query_params.get("state", ""), request.query_params.get("code", "")
        browser = request.cookies.get(FLOW_COOKIE, "")
        if not self.config or len(state) != 64 or len(browser) != 64:
            return self.failure()
        with self.store.engine.begin() as conn:
            flow = conn.execute(delete(login_flows).where(login_flows.c.state_hash == hashed(state),
                login_flows.c.browser_hash == hashed(browser), login_flows.c.expires_at > self.clock())
                .returning(login_flows)).mappings().first()
        if not flow or not code or len(code) > 2048 or request.query_params.get("error"):
            return self.failure()
        try:
            metadata = self.metadata()
            client_id = secret(self.config.client_id_env)
            response = self.client.post(metadata["token_endpoint"], auth=(client_id, secret(self.config.client_secret_env)),
                data={"grant_type": "authorization_code", "code": code, "redirect_uri": self.config.public_url + "/auth/callback",
                      "code_verifier": flow["verifier"]})
            response.raise_for_status()
            tokens = response.json()
            decoded = jwt.decode(tokens["id_token"], metadata["keys"], algorithms=["RS256"])
            claims = CodeIDToken(decoded.claims, decoded.header,
                options={"iss": {"essential": True, "value": self.config.issuer},
                         "aud": {"essential": True, "value": client_id}},
                params={"client_id": client_id, "nonce": flow["nonce"], "access_token": tokens.get("access_token")})
            claims.validate(now=self.clock(), leeway=30)
            if not isinstance(claims.get("sub"), str) or not claims["sub"] or not hmac.compare_digest(claims.get("nonce", ""), flow["nonce"]):
                raise ValueError("invalid identity")
            user = {"sub": claims["sub"], "name": str(claims.get("name") or claims.get("preferred_username") or claims["sub"])[:200],
                    "email": str(claims.get("email") or "")[:254], "role": "viewer"}
        except Exception:
            # Token responses and exception text may contain credentials.
            return self.failure()
        session = secrets.token_urlsafe(48)
        with self.store.engine.begin() as conn:
            old = request.cookies.get(COOKIE, "")
            if old:
                conn.execute(delete(user_sessions).where(user_sessions.c.token_hash == hashed(old)))
            conn.execute(user_sessions.insert().values(token_hash=hashed(session), user=user,
                expires_at=self.clock() + self.config.session_seconds))
        response = RedirectResponse(flow["return_to"], status_code=303)
        response.delete_cookie(FLOW_COOKIE, secure=True, httponly=True, samesite="lax")
        response.set_cookie(COOKIE, session, max_age=self.config.session_seconds, secure=True,
                            httponly=True, samesite="lax", path="/")
        return response

    @staticmethod
    def failure():
        response = RedirectResponse("/?auth_error=login_failed", status_code=303)
        response.delete_cookie(FLOW_COOKIE, secure=True, httponly=True, samesite="lax")
        return response

    def logout(self, request):
        if not self.config or request.headers.get("origin") != self.config.public_url or request.headers.get("x-sdm-request") != "logout":
            raise HTTPException(403, "origin_denied")
        with self.store.engine.begin() as conn:
            conn.execute(delete(user_sessions).where(user_sessions.c.token_hash == hashed(request.cookies.get(COOKIE, ""))))
        response = JSONResponse({"status": "signed_out"})
        response.delete_cookie(COOKIE, secure=True, httponly=True, samesite="lax")
        return response


def add_routes(app, auth):
    @app.get("/auth/session")
    def session(request: Request):
        return {"user": auth.identity(request), "sso_enabled": auth.config is not None}

    @app.get("/auth/login")
    def login(request: Request, next: str = "/"):
        try:
            return auth.login(request, next)
        except HTTPException as error:
            if error.status_code != 503:
                raise
            return RedirectResponse("/?auth_error=sso_unavailable", status_code=303)

    @app.get("/auth/callback")
    def callback(request: Request):
        return auth.callback(request)

    @app.post("/auth/logout")
    def logout(request: Request):
        return auth.logout(request)
