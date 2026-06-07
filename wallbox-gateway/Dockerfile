ARG BUILD_FROM
FROM ${BUILD_FROM}

ENV LANG=C.UTF-8

RUN apk add --no-cache python3 py3-pip py3-flask py3-requests

WORKDIR /app
COPY app/ /app/

COPY rootfs/ /

EXPOSE 8099

# s6-overlay (init: false in config.yaml) starts the service in
# rootfs/etc/services.d/wallbox/run.
