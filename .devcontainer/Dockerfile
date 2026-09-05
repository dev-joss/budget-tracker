FROM node:23.11.0-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends sudo netcat-openbsd \
    && rm -rf /var/lib/apt/lists/* \
    && echo 'node ALL=(root) NOPASSWD:ALL' > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node

ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
