ARG BUILD_FROM
FROM ${BUILD_FROM}

ENV LANG=C.UTF-8

RUN apk add --no-cache python3 py3-pip py3-flask py3-requests \
    && ( apk add --no-cache py3-websocket-client \
         || pip3 install --no-cache-dir --break-system-packages websocket-client \
         || pip3 install --no-cache-dir websocket-client \
         || true )
# websocket-client powers the optional Lovelace-page dropdown; if it can't be
# installed the page list just falls back to free-text (ha_bridge imports it
# lazily), so the build must not fail on it.

WORKDIR /app
COPY app/ /app/

COPY rootfs/ /

EXPOSE 8099

# s6-overlay (init: false in config.yaml) starts the service in
# rootfs/etc/services.d/wallbox/run.
