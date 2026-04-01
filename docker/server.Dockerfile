FROM oven/bun:1.3.9-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY . .

RUN bun install --frozen-lockfile

ENV T3CODE_HOME=/app/.t3code
ENV T3CODE_MODE=web
ENV T3CODE_NO_BROWSER=1

EXPOSE 3773

CMD ["bun", "run", "--cwd", "apps/server", "dev", "--", "--host", "0.0.0.0", "--port", "3773", "--no-browser"]
