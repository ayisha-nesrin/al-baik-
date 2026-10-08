FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV DATA_DIR=/data PORT=3000 NODE_ENV=production
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
