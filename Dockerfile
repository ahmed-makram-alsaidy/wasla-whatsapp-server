FROM node:20-slim

# Install system dependencies required by Baileys
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for layer caching
COPY package.json .npmrc ./

# Install dependencies
RUN npm install --legacy-peer-deps --ignore-scripts

# Copy rest of application
COPY . .

# Create auth directory for Baileys session
RUN mkdir -p auth_info_baileys

EXPOSE 3000

CMD ["node", "index.js"]
