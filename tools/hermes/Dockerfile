# Hermes Agent — image custom IA BOX
# Hérite de l'officielle + ajoute python-telegram-bot (canal Telegram natif)
#
# Construire localement (PAS de push registry) :
#   docker build -t hermes:iabox /srv/xefia/hermes/
#
# Ou via le compose qui a un block build: pour ça :
#   docker compose -f /srv/xefia/hermes/docker-compose.yml up -d --build
#
# Note: l'image officielle utilise `uv` (pas `pip`). On installe les extras
# dans le même venv /opt/hermes/.venv via `uv pip install --python ...`.
FROM nousresearch/hermes-agent:latest

USER root
RUN VIRTUAL_ENV=/opt/hermes/.venv uv pip install --no-cache-dir python-telegram-bot
USER hermes
