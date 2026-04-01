FROM oven/bun:1.3.9-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY . .

RUN bun install --frozen-lockfile

ENV PORT=5733
ENV VITE_WS_URL=wss://aicoder.propriotec.app/ws

EXPOSE 5733

CMD ["bun", "run", "--cwd", "apps/web", "dev", "--", "--host", "0.0.0.0", "--port", "5733"]
