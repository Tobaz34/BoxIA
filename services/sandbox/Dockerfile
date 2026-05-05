FROM python:3.12-slim

# Outils communs utilisés par les scripts utilisateur — installés au build
# pour ne pas avoir à pip install à chaud (le sandbox runtime est read-only
# en exec).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates jq \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Python libs userland préinstallées pour les scripts qu'on lance
# (l'utilisateur ne peut PAS pip install — sandbox read-only).
RUN pip install --no-cache-dir \
    pandas==2.2.3 openpyxl==3.1.5 reportlab==4.2.5 \
    requests==2.32.3 beautifulsoup4==4.12.3 lxml==5.3.0 \
    python-docx==1.1.2 pypdf==5.0.1 pillow==11.0.0

COPY app/ ./app/

# /tmp/work est tmpfs en runtime (cf docker-compose.yml). On crée le mount
# point pour que `os.makedirs` ne plante pas si tmpfs pas mappé.
RUN mkdir -p /tmp/work

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
