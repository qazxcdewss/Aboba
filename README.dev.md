# Aboba Dev Setup

## Prereqs
- Node.js LTS, npm
- Docker + Docker Compose

## Install
```powershell
npm install
npm run prepare
```

## Local infra
```powershell
docker compose up -d
```

## Run services (dev)
```powershell
npm run dev
```

- API: http://localhost:3000/health/live
- MinIO Console: http://localhost:9001 (minioadmin/minioadmin)

## Env (example)
Create `.env` in project root:
```
API_PORT=3000
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=aboba
POSTGRES_USER=aboba
POSTGRES_PASSWORD=aboba
REDIS_HOST=localhost
REDIS_PORT=6379
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET_ORIGINAL=aboba-media-original
S3_BUCKET_DERIVED=aboba-media-derived
TELEGRAM_BOT_TOKEN=
```

## Next
- Add DB migrations (Prisma/TypeORM)
- Implement media queues and TG bot per ADRs
