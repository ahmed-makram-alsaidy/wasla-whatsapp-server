FROM node:22-bullseye-slim

# System dependencies required by Baileys & native modules
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    make \
    g++ \
    libssl-dev \
    libc6-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency files
COPY package.json .npmrc ./

# Install with flags to avoid native build issues
RUN npm install --legacy-peer-deps --ignore-scripts

# Re-run postinstall only for safe packages
RUN npm rebuild 2>/dev/null || true

# Copy application code
COPY . .

# Session directory for Baileys
RUN mkdir -p auth_info_baileys

EXPOSE 3000

CMD ["node", "index.js"]
