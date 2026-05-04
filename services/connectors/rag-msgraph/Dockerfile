FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        poppler-utils \
        tesseract-ocr tesseract-ocr-fra \
        libmagic1 \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN python -c "import nltk; nltk.download('punkt', download_dir='/usr/local/nltk_data'); nltk.download('punkt_tab', download_dir='/usr/local/nltk_data'); nltk.download('averaged_perceptron_tagger_eng', download_dir='/usr/local/nltk_data')"
ENV NLTK_DATA=/usr/local/nltk_data
COPY . .

CMD ["python", "-u", "worker.py"]
