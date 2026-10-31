FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
CMD ["sh", "-c", "node src/deploy-commands.js && node src/index.js"]
