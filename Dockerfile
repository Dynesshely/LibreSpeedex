FROM php:8-apache

# use docker-php-extension-installer for automatically get the right packages installed
ADD --chmod=0755 https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions /usr/local/bin/

# Install extensions and cleanup in a single layer to reduce image size
RUN install-php-extensions iconv gd pdo pdo_mysql pdo_pgsql pgsql \
    && rm -f /usr/src/php.tar.xz /usr/src/php.tar.xz.asc \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY docker/librespeed-php.ini ${PHP_INI_DIR}/conf.d/99-librespeed.ini

# Prepare files and folders
RUN mkdir -p /speedtest/

# Copy sources
COPY backend/ /speedtest/backend
# frontend/styling/tailwind.css is generated: run `npm run css` after changing
# the markup, before building this image.
COPY frontend/ /speedtest/frontend

COPY results/*.php /speedtest/results/
COPY results/*.ttf /speedtest/results/
# The admin panel is static markup; the PHP beside it is its API.
COPY results/*.html /speedtest/results/

COPY *.js /speedtest/
COPY index.html /speedtest/
# The visitor's own records page.
COPY my-results.html /speedtest/
COPY settings.json /speedtest/
COPY server-list.json /speedtest/
COPY stability.html /speedtest/
COPY favicon.ico /speedtest/
COPY manifest.webmanifest /speedtest/
COPY images/ /speedtest/images/

COPY docker/entrypoint.sh /

# Prepare default environment variables
ENV TITLE=LibreSpeedex
ENV TAGLINE="No Flash, No Java, No Websockets, No Bullsh*t"
ENV MODE=standalone
ENV PASSWORD=password
ENV TELEMETRY=false
ENV ENABLE_ID_OBFUSCATION=false
ENV REDACT_IP_ADDRESSES=false
ENV WEBPORT=8080

# Backend policy. TRUSTED_PROXIES is the list of peers whose forwarding headers
# are believed; empty means only the addresses in backend/backend_settings.php.
ENV TRUSTED_PROXIES=""
ENV GARBAGE_MAX_CHUNK_MB=256
ENV GARBAGE_MAX_CONCURRENT=64
ENV GARBAGE_MAX_CONCURRENT_PER_IP=16
ENV SERVER_INFO_EXPOSE_INTERFACE=true
ENV SERVER_INFO_PUBLIC_IP=true
ENV SERVER_INFO_PUBLIC_IP_TTL=3600
# The node label shown above the endpoint address
ENV SERVER_NODE_NAME=local
# Telemetry retention and write limits
ENV TELEMETRY_RETENTION_DAYS=90
ENV TELEMETRY_RATE_LIMIT=60
ENV TELEMETRY_RATE_LIMIT_IP=240

# https://httpd.apache.org/docs/2.4/stopping.html#gracefulstop
STOPSIGNAL SIGWINCH

# Add labels for better metadata
LABEL org.opencontainers.image.title="LibreSpeedex"
LABEL org.opencontainers.image.description="A Free and Open Source speed test that you can host on your server(s)"
LABEL org.opencontainers.image.vendor="LibreSpeed"
LABEL org.opencontainers.image.url="https://github.com/librespeed/speedtest"
LABEL org.opencontainers.image.source="https://github.com/librespeed/speedtest"
LABEL org.opencontainers.image.documentation="https://github.com/librespeed/speedtest/blob/master/doc_docker.md"
LABEL org.opencontainers.image.licenses="LGPL-3.0-or-later"

# Add health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${WEBPORT}/ || exit 1

# Final touches
EXPOSE ${WEBPORT}
CMD ["bash", "/entrypoint.sh"]
