# syntax=docker/dockerfile:1

# Circadia stdio container.
#
# This image runs the SAME program as the npm package, packaged differently: it installs
# the packed tarball globally and runs `circadia mcp` over stdio. There is no network
# listener, no scheduler, no `serve` command, and no EXPOSE. The separate
# `circadia-server` image in docs/rfcs/RFC-0003-server-container.md adds those; this one
# deliberately does not.
#
# The runtime stage installs the PACKED TARBALL, so the image exercises the same install
# path an npm user takes (ADR-0012: the launcher runs dist/ when installed under
# node_modules).

# Base image pinned by its multi-arch index digest (tag: node:24-bookworm-slim).
# Verified with: docker buildx imagetools inspect node:24-bookworm-slim
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build

WORKDIR /app

# git is required by the test suite (test/git-safety.test.ts and the git-backed
# consolidation/history tests spawn it); the slim base image does not ship it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install dev dependencies first so this layer caches when only source changes.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the source and run the same gates CI runs. `npm pack` runs `prepack`
# (the publish-time tsc build, ADR-0012) and leaves circadia-<version>.tgz in /app.
COPY . .
RUN npm run build \
 && npm test \
 && npm pack

# ---------------------------------------------------------------------------

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime

# git is needed for consolidation commits, `history`, and git-backed `--as-of`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install the packed tarball exactly as an npm user would. --ignore-scripts: the tarball
# already contains dist/ (built by prepack at pack time) and the runtime image has no
# TypeScript toolchain to rebuild it.
COPY --from=build /app/circadia-*.tgz /tmp/
RUN npm install -g /tmp/circadia-*.tgz --ignore-scripts \
 && rm -f /tmp/circadia-*.tgz \
 # Zero runtime dependencies (AGENTS.md §3.1): the global install must pull in nothing
 # else. Fail the build if a node_modules directory appears with anything in it.
 && test -z "$(ls -A /usr/local/lib/node_modules/circadia/node_modules 2>/dev/null)" \
 # Nothing in the image should be able to install packages.
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack

# A vault bind-mounted from the host is owned by a different uid than the container's, so
# git would refuse it as "dubious ownership". Name that path only, never `*`.
RUN git config --system safe.directory /vault

# HOME must be writable under --read-only; /tmp is a tmpfs. Default commit identity for
# consolidation commits; the user can override it.
ENV HOME=/tmp \
    GIT_AUTHOR_NAME=Circadia \
    GIT_AUTHOR_EMAIL=circadia@example.invalid \
    GIT_COMMITTER_NAME=Circadia \
    GIT_COMMITTER_EMAIL=circadia@example.invalid

# The base image's non-root `node` user is uid 1000. Create the vault mount point and
# hand it to that uid before dropping privileges.
RUN mkdir -p /vault && chown 1000:1000 /vault

USER 1000:1000
WORKDIR /vault
VOLUME /vault

ENTRYPOINT ["circadia"]
CMD ["mcp", "--vault", "/vault"]
