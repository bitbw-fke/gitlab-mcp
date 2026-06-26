FROM node:lts-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application code
COPY dist/* ./

EXPOSE 3000

CMD ["node", "index.js"]
