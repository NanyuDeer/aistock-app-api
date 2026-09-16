#!/bin/bash
set -e

APP_DIR="/home/aistock/aistock-app-api"
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
# BUG FIX(2026-09-16)：pm2 实际应用名为 aistock-app-api（见 deploy/ecosystem.config.json）。
# 此前写 aistock-api（旧应用）会导致 restart 命中空名、误 start 出重复实例，安全修复无法生效。
pm2 restart aistock-app-api || pm2 start deploy/ecosystem.config.json --only aistock-app-api

echo "=== 部署完成 ==="
pm2 status
