FROM python:3.12-slim-bookworm
# FFmpeg (with libass and libx264) for every render; Noto as the system fallback behind the bundled caption fonts.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY server.py /app/server.py
COPY fonts /app/fonts
RUN useradd --create-home renderer
USER renderer
EXPOSE 8080
CMD ["python", "-u", "/app/server.py"]
