# Image AI Box Hermes — basée sur l'officielle Nous Research + extras.
# Build : docker compose -f docker-compose.hermes.yml build
FROM nousresearch/hermes-agent:latest

USER root
RUN VIRTUAL_ENV=/opt/hermes/.venv uv pip install --no-cache-dir \
    python-telegram-bot \
    httpx
USER hermes
