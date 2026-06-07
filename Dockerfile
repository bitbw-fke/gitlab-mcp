FROM node:lts-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application code
COPY dist/* ./

# Set environment variables for gitlab
# These should be provided at runtime for security purposes
ENV MR_MCP_GITLAB_TOKEN your_gitlab_token

EXPOSE 3000

CMD ["node", "index.js"]
