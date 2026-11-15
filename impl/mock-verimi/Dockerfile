# Stand-in for the retired Verimi OIDC provider (demo only).
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3443

WORKDIR /app

COPY --chown=node:node server.js ./

# Runs as root on purpose: it must read the demo TLS key from a bind mount whose
# ownership follows the host UID. The container exposes nothing but OIDC routes
# and holds no secret beyond the demo client secret (env only).
EXPOSE 3443

CMD ["node", "server.js"]
