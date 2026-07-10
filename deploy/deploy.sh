#!/bin/bash
set -e

APP_DIR="/home/aistock/aistock-api"
FRONTEND_SRC="/home/aistock/aistock-frontend"
FRONTEND_DIST="/var/www/aistock"

echo "=== aistock-api 部署脚本 ==="

echo "[1/6] 安装后端依赖..."
cd "$APP_DIR"
npm install

echo "[2/6] 编译 TypeScript..."
npx tsc

echo "[3/6] 运行数据库迁移..."
docker exec -i pg psql -U root -d aistock < scripts/001_init_tables.sql

echo "[4/6] 编译前端..."
cd "$FRONTEND_SRC"
npm install
npm run build

echo "[5/6] 部署前端静态文件..."
rm -rf "$FRONTEND_DIST"/*
cp -r "$FRONTEND_SRC/dist/"* "$FRONTEND_DIST"

echo "[6/6] 重启后端服务..."
cd "$APP_DIR"
pm2 restart aistock-api || pm2 start deploy/ecosystem.config.json --only aistock-api

echo "=== 部署完成 ==="
pm2 status
