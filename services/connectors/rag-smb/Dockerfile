FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1

# Outils nécessaires pour parsing PDF/DOCX et OCR léger
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        smbclient \
        poppler-utils \
        tesseract-ocr tesseract-ocr-fra \
        libmagic1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "-u", "worker.py"]
