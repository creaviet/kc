# Minimal runtime image for the portal API.
# No npm install: the handler only uses Node built-ins (node:crypto, fetch).
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    STORE_PATH=/data/mappings.json

WORKDIR /app

COPY --chown=node:node package.json handler.js local-server.js ./

# Writable volume for the (demo) JSON store.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

CMD ["node", "local-server.js"]
