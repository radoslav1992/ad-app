FROM python:3.12-slim-bookworm
# FFmpeg (with libass and libx264) for every render; Noto as the system fallback behind the bundled caption fonts.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core ca-certificates && rm -rf /var/lib/apt/lists/*
# Face tracking for "follow the speaker" (operation 'track', as rech-bg): OpenCV without GUI libraries, and the YuNet
# face detector (MIT licence, github.com/opencv/opencv_zoo) at a fixed commit, checked against its published SHA-256.
RUN pip install --no-cache-dir opencv-python-headless==4.14.0.94 numpy==2.4.6
ARG YUNET_URL=https://media.githubusercontent.com/media/opencv/opencv_zoo/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
ARG YUNET_SHA256=8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4
RUN mkdir -p /app/models && python -c "import hashlib, urllib.request; d = urllib.request.urlopen('$YUNET_URL', timeout=120).read(); \
assert hashlib.sha256(d).hexdigest() == '$YUNET_SHA256', 'YuNet model: checksum mismatch'; \
open('/app/models/face_detection_yunet_2023mar.onnx', 'wb').write(d)"
ENV PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY server.py /app/server.py
COPY fonts /app/fonts
RUN useradd --create-home renderer
USER renderer
EXPOSE 8080
CMD ["python", "-u", "/app/server.py"]
