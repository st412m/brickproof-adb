# Standalone image: brickproof-adb over Streamable HTTP. Published as
# ghcr.io/st412m/brickproof-adb by .github/workflows/image.yml on a version
# tag; to build it yourself:
#   docker build -t brickproof-adb:1.0.0 .
# The server comes from npm, pinned below. To build from an `npm pack` tarball
# placed next to this file instead (before a release, or a local change):
#   docker build --build-arg BRICKPROOF_TARBALL=brickproof-adb-1.0.0.tgz -t brickproof-adb:1.0.0 .
FROM node:22.23.3-alpine3.24

# A tarball in the build context, by file name; empty = brickproof-adb from npm.
ARG BRICKPROOF_TARBALL=

# android-tools: adb. Not npm -g: the install goes into its own directory and
# a link. `check --offline` runs the image pipeline and finds adb, or the
# build fails.
RUN --mount=type=bind,target=/ctx \
    apk add --no-cache android-tools \
    && SRC=brickproof-adb@1.0.0 \
    && if [ -n "$BRICKPROOF_TARBALL" ]; then SRC="/ctx/$BRICKPROOF_TARBALL"; fi \
    && mkdir -p /opt/brickproof-adb \
    && cd /opt/brickproof-adb \
    && npm install --ignore-scripts --omit=optional --no-package-lock --no-save "$SRC" \
    && ln -s /opt/brickproof-adb/node_modules/.bin/brickproof-adb /usr/local/bin/brickproof-adb \
    && npm cache clean --force \
    && mkdir -p /data/.android \
    && chown -R node:node /data \
    && HOME=/tmp BRICKPROOF_STATE_DIR=/tmp/brickproof-check brickproof-adb check --offline \
    && rm -rf /tmp/brickproof-check

# /data holds the token, the snapshot store and the adb keys (HOME=/data, so
# ~/.android/adbkey is /data/.android/adbkey and devices keep trusting this
# server across updates). The process runs as "node" (uid 1000): /data must be
# writable by it.
ENV HOME=/data BRICKPROOF_STATE_DIR=/data
# Settings come from BRICKPROOF_* variables of the container: refusals say
# which one to set.
ENV BRICKPROOF_SETTINGS_UI="the environment of the container"
VOLUME /data

USER node
EXPOSE 3200
CMD ["brickproof-adb", "serve", "--host", "0.0.0.0", "--port", "3200"]
