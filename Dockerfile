# Use official Node.js LTS image
# (bumped from node:18-alpine on 2026-05-02 — AWS SDK v3 drops Node 18 support)
FROM node:20-alpine

# Install Docker CLI (for container monitoring)
RUN apk add --no-cache docker-cli

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create data directory with proper permissions
RUN mkdir -p /app/data && chown -R node:node /app/data

# Add node user to docker group (GID 999 is common, will be overridden by host)
RUN addgroup -g 999 docker 2>/dev/null || true && addgroup node docker 2>/dev/null || true

# Expose port
EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production

# Run as non-root user
USER node

# Start application
CMD ["npm", "start"]

