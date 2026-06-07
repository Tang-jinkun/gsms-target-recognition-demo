FROM node:20-alpine

WORKDIR /workspace

COPY packages/skills-core/package.json packages/skills-core/package-lock.json ./packages/skills-core/
COPY packages/agent-core/package.json packages/agent-core/package-lock.json ./packages/agent-core/
COPY agent/package.json agent/package-lock.json ./agent/

RUN cd packages/skills-core && npm ci && \
    cd ../agent-core && npm ci && \
    cd ../../agent && npm ci

COPY packages/skills-core ./packages/skills-core
COPY packages/agent-core ./packages/agent-core
COPY agent ./agent

WORKDIR /workspace/agent

CMD ["npm", "run", "worker"]
