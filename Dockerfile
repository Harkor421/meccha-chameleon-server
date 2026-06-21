# Minimal production image. Only ws is needed at runtime.
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# install prod deps only (leverages layer cache)
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

EXPOSE 8787
# basic container healthcheck against the HTTP /health endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
