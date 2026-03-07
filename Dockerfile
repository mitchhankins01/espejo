FROM node:18-slim AS builder
WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ packages/
COPY web/package.json web/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build
RUN cd web && pnpm build

FROM node:18-slim
WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1))"
CMD ["node", "dist/src/index.js", "--http"]
