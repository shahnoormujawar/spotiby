# Spotiby on Hugging Face Spaces (Docker). Also works anywhere Docker runs.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Spaces run the container as uid 1000
RUN useradd -m -u 1000 user
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Preload yt-dlp so the first request doesn't wait on a download
RUN mkdir -p bin data \
  && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp \
  && chmod +x bin/yt-dlp \
  && chown -R user:user /app

USER user
ENV HOME=/home/user PORT=7860 NODE_ENV=production
EXPOSE 7860
CMD ["node", "server.js"]
