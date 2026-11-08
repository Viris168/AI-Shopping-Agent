FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /srv

COPY pyproject.toml ./
COPY app ./app
COPY evals ./evals
# Installed as root, run as uid 10001 with no home and no login shell: it can't modify its own code.
RUN pip install . \
 && useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin agent
USER agent:agent

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health').status == 200 else 1)"
# Secrets (ANTHROPIC_API_KEY, JWT_SECRET, SERVICE_TOKEN) come from the runtime environment, never the image.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
