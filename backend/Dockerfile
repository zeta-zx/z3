FROM python:3.13-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y git ffmpeg curl unzip && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

COPY pyproject.toml uv.lock ./
RUN pip install .

COPY src ./src

EXPOSE 80

CMD ["uvicorn", "src.app:app", "--host", "0.0.0.0", "--port", "80"]
