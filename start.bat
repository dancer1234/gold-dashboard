@echo off
chcp 65001 >nul 2>&1
title Gold Realtime Dashboard
cd /d "C:\Users\admin\Desktop\web"
echo Starting Gold Realtime Dashboard...
node server.js
pause