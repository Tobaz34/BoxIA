#!/bin/bash
# Crée la base `dify_plugin` requise par le plugin-daemon de Dify 1.x.
# Exécuté une seule fois au tout premier démarrage de Postgres
# (docker-entrypoint-initdb.d ne ré-exécute pas si la DB existe déjà).
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  SELECT 'CREATE DATABASE dify_plugin'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'dify_plugin')\gexec
EOSQL
