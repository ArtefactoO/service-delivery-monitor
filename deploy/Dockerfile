FROM python:3.12-slim AS lock
WORKDIR /build
RUN pip install --no-cache-dir pip-tools==7.5.0
COPY backend/pyproject.toml .
RUN pip-compile --generate-hashes --output-file=requirements.lock pyproject.toml \
 && pip-compile --generate-hashes --extra=test --output-file=requirements-test.lock pyproject.toml

FROM node:22-bookworm-slim AS frontend
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
COPY frontend/packages ./packages
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
RUN DELIVERY_MONITOR_CACHE_DIR=/tmp/vite DELIVERY_MONITOR_BUILD_DIR=/static pnpm build

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY backend/requirements.lock .
RUN pip install --no-cache-dir --require-hashes -r requirements.lock \
 && groupadd --gid 10001 sdm && useradd --uid 10001 --gid 10001 --no-create-home sdm
COPY backend/sdm ./sdm
COPY backend/config ./config
COPY scripts/local-read.py ./local-read.py
COPY --from=frontend /static ./static
USER 10001:10001
EXPOSE 8080
CMD ["python", "-m", "sdm", "serve"]

FROM runtime AS test
USER root
COPY backend/requirements-test.lock .
RUN pip install --no-cache-dir --require-hashes -r requirements-test.lock
COPY backend/tests ./tests
COPY backend/pyproject.toml .
USER 10001:10001
CMD ["python", "-m", "pytest"]
