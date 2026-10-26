import hashlib
import json
import time
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient
import httpx
from joserfc import jwt
from joserfc.jwk import RSAKey
import pytest
from sqlalchemy import select, update

from sdm.api import create_app
from sdm.auth import BrowserAuth, COOKIE, FLOW_COOKIE, hashed, return_path
from sdm.config import OIDC
from sdm.store import login_flows, user_sessions


@pytest.fixture
def oidc(store, settings, monkeypatch):
    monkeypatch.setenv('SDM_OIDC_CLIENT_ID', 'fixture-client')
    monkeypatch.setenv('SDM_OIDC_CLIENT_SECRET', 'fixture-oidc-secret-not-a-real-credential')
    settings.oidc = OIDC(issuer='https://id.example/application/o/sdm/', public_url='https://sdm.example')
    key = RSAKey.generate_key(2048, parameters={'kid': 'fixture-key'})
    state = {'claims': {}, 'calls': [], 'key': key}
    def handle(request):
        state['calls'].append(request)
        if request.url.path.endswith('openid-configuration'):
            return httpx.Response(200, json={'issuer': settings.oidc.issuer, 'authorization_endpoint': 'https://id.example/authorize', 'token_endpoint': 'https://id.example/token', 'jwks_uri': 'https://id.example/jwks'})
        if request.url.path == '/jwks':
            return httpx.Response(200, json={'keys': [key.as_dict(private=False)]})
        if request.url.path == '/token':
            now = int(time.time())
            claims = {'iss': settings.oidc.issuer, 'aud': 'fixture-client', 'sub': 'new-user', 'name': 'New User', 'iat': now, 'exp': now + 120, 'nonce': state['nonce'], **state['claims']}
            return httpx.Response(200, json={'id_token': jwt.encode({'alg': 'RS256', 'kid': 'fixture-key'}, claims, state['key']), 'access_token': 'ephemeral-fixture-token', 'token_type': 'Bearer'})
        raise AssertionError(request.url)
    auth = BrowserAuth(settings.oidc, store, client=httpx.Client(transport=httpx.MockTransport(handle)))
    with TestClient(create_app(settings, store, browser_auth=auth), base_url='https://sdm.example') as client:
        def login(next_path='/?page=service&service=sample&view=map&resource=repo'):
            response = client.get('/auth/login', params={'next': next_path}, follow_redirects=False)
            query = parse_qs(urlsplit(response.headers['location']).query)
            state['nonce'] = query['nonce'][0]
            state['query'] = query
            return query['state'][0]
        state.update(client=client, login=login, auth=auth)
        yield state


def test_oidc_login_issues_read_only_revocable_session(oidc, store):
    client = oidc['client']
    assert client.get('/api/v1/services').status_code == 401
    assert client.get('/api/v1/services', headers={'X-Forwarded-User': 'admin'}).status_code == 401
    state = oidc['login']()
    with store.engine.connect() as conn:
        flow = conn.execute(select(login_flows)).mappings().one()
    challenge = oidc['query']['code_challenge'][0]
    import base64
    assert challenge == base64.urlsafe_b64encode(hashlib.sha256(flow['verifier'].encode()).digest()).rstrip(b'=').decode()
    response = client.get('/auth/callback', params={'code': 'test-code', 'state': state}, follow_redirects=False)
    assert response.status_code == 303 and response.headers['location'].startswith('/?page=service')
    cookie = response.headers['set-cookie']
    assert 'Secure' in cookie and 'HttpOnly' in cookie and 'SameSite=lax' in cookie
    assert 'ephemeral-fixture-token' not in cookie
    assert client.get('/auth/session').json()['user']['role'] == 'viewer'
    assert client.get('/api/v1/services').status_code == 200
    assert client.get('/api/v1/services/sample').status_code == 200
    assert client.get('/api/v1/events').status_code == 200
    assert client.get('/api/v1/services').headers['cache-control'] == 'no-store'
    with store.engine.connect() as conn:
        saved = conn.execute(select(user_sessions)).mappings().one()
    assert saved['token_hash'] == hashed(client.cookies[COOKIE])
    assert 'ephemeral-fixture-token' not in json.dumps(dict(saved))
    assert client.post('/auth/logout', headers={'Origin': 'https://evil.example', 'X-SDM-Request': 'logout'}).status_code == 403
    assert client.post('/auth/logout', headers={'Origin': 'https://sdm.example', 'X-SDM-Request': 'logout'}).status_code == 200
    assert client.get('/api/v1/services').status_code == 401
    # One-time flow cannot create another session after logout.
    assert 'auth_error' in client.get('/auth/callback', params={'code': 'test-code', 'state': state}, follow_redirects=False).headers['location']


@pytest.mark.parametrize('claims', [{'nonce': 'wrong'}, {'iss': 'https://evil.example/'}, {'aud': 'other-client'}, {'exp': 1}, {'azp': 'other-client'}, {'sub': ''}])
def test_invalid_id_token_never_authenticates(oidc, claims):
    state = oidc['login'](); oidc['claims'] = claims
    response = oidc['client'].get('/auth/callback', params={'code': 'test-code', 'state': state}, follow_redirects=False)
    assert 'auth_error' in response.headers['location']
    assert oidc['client'].get('/api/v1/services').status_code == 401


def test_bad_signature_and_browser_binding(oidc):
    state = oidc['login']()
    cookie = oidc['client'].cookies[FLOW_COOKIE]
    oidc['client'].cookies.clear()
    assert 'auth_error' in oidc['client'].get('/auth/callback', params={'code': 'test-code', 'state': state}, follow_redirects=False).headers['location']
    assert not any(r.url.path == '/token' for r in oidc['calls'])
    oidc['client'].cookies.set(FLOW_COOKIE, cookie)
    oidc['key'] = RSAKey.generate_key(2048, parameters={'kid': 'fixture-key'})
    assert 'auth_error' in oidc['client'].get('/auth/callback', params={'code': 'test-code', 'state': state}, follow_redirects=False).headers['location']


def test_expired_flow_and_session(oidc, store):
    state = oidc['login']()
    with store.engine.begin() as conn:
        conn.execute(update(login_flows).values(expires_at=1))
    assert 'auth_error' in oidc['client'].get('/auth/callback', params={'code': 'test-code', 'state': state}, follow_redirects=False).headers['location']
    state = oidc['login']()
    oidc['client'].get('/auth/callback', params={'code': 'test-code', 'state': state}, follow_redirects=False)
    with store.engine.begin() as conn:
        conn.execute(update(user_sessions).values(expires_at=1))
    assert oidc['client'].get('/api/v1/services').status_code == 401


@pytest.mark.parametrize('ttl', [3600, 86400])
def test_session_cookie_and_server_expire_at_configured_limit(oidc, store, ttl):
    now = int(time.time())
    oidc['auth'].clock = lambda: now
    oidc['auth'].config.session_seconds = ttl
    state = oidc['login']()
    response = oidc['client'].get('/auth/callback', params={'code': 'test-code', 'state': state}, follow_redirects=False)
    cookie = next(value for value in response.headers.get_list('set-cookie') if value.startswith(COOKIE + '='))
    assert f'Max-Age={ttl}' in cookie
    with store.engine.connect() as conn:
        expires_at = conn.execute(select(user_sessions.c.expires_at)).scalar_one()
    assert expires_at == now + ttl
    now += ttl - 1
    assert oidc['client'].get('/api/v1/services').status_code == 200
    with store.engine.connect() as conn:
        assert conn.execute(select(user_sessions.c.expires_at)).scalar_one() == expires_at
    now += 1
    assert oidc['client'].get('/api/v1/services').status_code == 401


def test_session_duration_cannot_exceed_one_day():
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        OIDC(issuer='https://id.example/application/o/sdm/', public_url='https://sdm.example', session_seconds=86401)


def test_browser_session_cannot_ingest_events(oidc, event, store):
    state = oidc['login']()
    oidc['client'].get('/auth/callback', params={'code': 'test-code', 'state': state}, follow_redirects=False)
    response = oidc['client'].post('/api/v1/events', json=event(), headers={'X-Producer-ID': 'publisher'})
    assert response.status_code == 401
    assert not store.event_history('sample')


@pytest.mark.parametrize('value', ['https://evil.example', '//evil.example', '/\\evil.example', '/auth/callback?code=x', '/\nLocation:x'])
def test_return_url_is_local(value):
    assert return_path(value) == '/'
