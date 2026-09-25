FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

WORKDIR /app
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node bin/ ./bin/
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node public/ ./public/

RUN mkdir -p /home/dev/.agent-console/hub && chown -R node:node /home/dev
ENV HOME=/home/dev
USER node
VOLUME ["/home/dev/.agent-console/hub"]
EXPOSE 6788
ENTRYPOINT ["node", "bin/agent-console.mjs"]
CMD ["--no-local", "--listen", "0.0.0.0"]
