FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

EXPOSE 8000

# uvicorn directement (pas gunicorn — single process, suffit pour notre
# usage scheduler avec ~20-50 jobs max).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
