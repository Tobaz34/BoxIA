FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
RUN pip install --no-cache-dir fastapi==0.115.5 uvicorn[standard]==0.32.1 httpx==0.28.1 pydantic==2.10.4
COPY worker.py .
EXPOSE 8000
CMD ["uvicorn", "worker:app", "--host", "0.0.0.0", "--port", "8000"]
